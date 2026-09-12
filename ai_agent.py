import json
import os
import httpx
from openai import OpenAI
from git_manager import GitManager

class AIAgent:
    def __init__(self, api_key=None, base_url="https://openrouter.ai/api/v1", model="openrouter/free"):
        self.api_key = api_key or os.getenv("OPENROUTER_API_KEY")
        self.base_url = base_url
        self.model = model
        self.client = None
        self.conversation_history = []
        self.git_manager = GitManager()
        self.setup_client()
        self.init_system_prompt()

    def setup_client(self):
        """Initializes the OpenAI client configured for OpenRouter API."""
        api_key = self.api_key or os.getenv("OPENROUTER_API_KEY")
        if not api_key:
            api_key = "dummy-key-for-init"
            
        self.client = OpenAI(
            base_url=self.base_url,
            api_key=api_key,
            default_headers={
                "HTTP-Referer": "https://avfenix-studio.org",
                "X-Title": "AVFenix Studio IDE"
            }
        )

    def set_model(self, model_name):
        """Allows dynamically updating the AI model."""
        if model_name:
            self.model = model_name

    def init_system_prompt(self):
        """Initializes the base system prompt for the AI agent."""
        self.conversation_history = [
            {
                "role": "system",
                "content": (
                    "You are AVFenix Copilot, an advanced AI programming assistant embedded within a Linux IDE.\n"
                    "Your role is to assist developers with code generation, debugging, refactoring, code explanation, and workspace management.\n"
                    "When active tab file context is provided, carefully examine the active file content and reference line numbers or sections when giving advice.\n"
                    "When modifying or deleting files, use tool calls (`write_file` / `delete_file`), which will trigger visual user approval (Monaco Diff Editor / native desktop confirmation dialog).\n"
                    "Always format code blocks with language identifiers for clean rendering. Be concise, accurate, and professional."
                )
            }
        ]

    def get_tools_definition(self):
        """Returns function definitions for OpenRouter Tool Calling."""
        return [
            {
                "type": "function",
                "function": {
                    "name": "read_file",
                    "description": "Reads the text content of a local file in the project workspace.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "filepath": {
                                "type": "string",
                                "description": "The path to the file relative to the workspace root."
                            }
                        },
                        "required": ["filepath"]
                    }
                }
            },
            {
                "type": "function",
                "function": {
                    "name": "write_file",
                    "description": "Proposes a new file or modifications to an existing file. Triggers visual Monaco Diff comparison for user approval before writing.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "filepath": {
                                "type": "string",
                                "description": "The path to the file relative to the workspace root."
                            },
                            "content": {
                                "type": "string",
                                "description": "The complete source code or modified text to write to the file."
                            }
                        },
                        "required": ["filepath", "content"]
                    }
                }
            },
            {
                "type": "function",
                "function": {
                    "name": "delete_file",
                    "description": "Proposes file deletion. Triggers a native desktop confirmation dialog.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "filepath": {
                                "type": "string",
                                "description": "The path to the file relative to the workspace root."
                            }
                        },
                        "required": ["filepath"]
                    }
                }
            },
            {
                "type": "function",
                "function": {
                    "name": "list_files",
                    "description": "Lists all directories and files in the project workspace layout.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "dirpath": {
                                "type": "string",
                                "description": "The folder path to list (default is current workspace root).",
                                "default": "."
                            }
                        }
                    }
                }
            },
            {
                "type": "function",
                "function": {
                    "name": "get_git_status",
                    "description": "Queries current local Git repository status (active branch, staged files, modified/untracked files, and commits ahead/behind).",
                    "parameters": {
                        "type": "object",
                        "properties": {}
                    }
                }
            }
        ]

    async def execute_tool(self, name, args, ws_callback):
        """Executes the specific tool called by the model."""
        if name == "read_file":
            filepath = args.get("filepath")
            try:
                with open(filepath, "r", encoding="utf-8") as f:
                    return {"status": "success", "content": f.read()}
            except Exception as e:
                return {"status": "error", "message": f"Could not read file {filepath}: {str(e)}"}

        elif name == "write_file":
            filepath = args.get("filepath")
            content = args.get("content")
            proposal_msg = json.dumps({
                "action": "write_proposal",
                "filepath": filepath,
                "content": content
            })
            await ws_callback(proposal_msg)
            return {
                "status": "proposal_sent",
                "message": f"Proposal to write {filepath} was sent to the user interface for approval via Monaco Diff. Waiting on user action."
            }

        elif name == "delete_file":
            filepath = args.get("filepath")
            proposal_msg = json.dumps({
                "action": "delete_proposal",
                "filepath": filepath
            })
            await ws_callback(proposal_msg)
            return {
                "status": "proposal_sent",
                "message": f"Deletion of {filepath} was requested. A native confirmation dialog has been triggered for the user."
            }

        elif name == "list_files":
            dirpath = args.get("dirpath", ".")
            try:
                tree = []
                for root, dirs, files in os.walk(dirpath):
                    dirs[:] = [d for d in dirs if d not in (".git", "node_modules", "__pycache__", "venv", ".venv")]
                    for file in files:
                        rel_path = os.path.relpath(os.path.join(root, file), dirpath)
                        tree.append(rel_path)
                return {"status": "success", "files": tree}
            except Exception as e:
                return {"status": "error", "message": f"Could not list files under {dirpath}: {str(e)}"}

        elif name == "get_git_status":
            try:
                status = self.git_manager.get_status()
                return {"status": "success", "data": status}
            except Exception as e:
                return {"status": "error", "message": f"Git status failed: {str(e)}"}

        return {"status": "error", "message": f"Unknown tool: {name}"}

    async def chat(self, user_message, ws_callback, model=None, context=None):
        """Sends user message to OpenRouter API with active tab context and processes tool calling."""
        api_key = os.getenv("OPENROUTER_API_KEY")
        if not api_key or api_key == "your-openrouter-key" or api_key == "dummy-key-for-init":
            return (
                "⚠️ **Error de API Key**: No se ha detectado una clave válida de OpenRouter.\n\n"
                "Por favor, exporta tu variable de entorno en la terminal antes de iniciar el IDE:\n"
                "```bash\nexport OPENROUTER_API_KEY=\"sk-or-v1-tu-clave-aqui\"\n```"
            )

        target_model = model or self.model
        
        # Build prompt payload with active file context if supplied
        user_content = user_message
        if context and context.get("filepath") and context.get("content"):
            filepath = context.get("filepath")
            content = context.get("content")
            language = context.get("language", "text")
            
            # Truncate content if extremely large to stay within limits
            max_len = 25000
            if len(content) > max_len:
                content = content[:max_len] + "\n...[Contenido del archivo truncado por límite de tamaño]..."

            user_content = (
                f"📌 **[CONTEXTO DE LA PESTAÑA ACTIVA]**\n"
                f"Archivo: `{filepath}` | Lenguaje: `{language}`\n"
                f"```\n{content}\n```\n\n"
                f"💬 **Consulta del usuario:** {user_message}"
            )

        self.conversation_history.append({"role": "user", "content": user_content})

        try:
            # Refresh client with active key if needed
            self.client.api_key = api_key
            
            response = self.client.chat.completions.create(
                model=target_model,
                messages=self.conversation_history,
                tools=self.get_tools_definition(),
                tool_choice="auto"
            )

            assistant_message = response.choices[0].message
            self.conversation_history.append(assistant_message)

            # Check for tool calling
            if assistant_message.tool_calls:
                for tool_call in assistant_message.tool_calls:
                    name = tool_call.function.name
                    args = json.loads(tool_call.function.arguments or "{}")
                    
                    result = await self.execute_tool(name, args, ws_callback)
                    
                    self.conversation_history.append({
                        "role": "tool",
                        "tool_call_id": tool_call.id,
                        "name": name,
                        "content": json.dumps(result)
                    })

                second_response = self.client.chat.completions.create(
                    model=target_model,
                    messages=self.conversation_history
                )
                final_content = second_response.choices[0].message.content
                self.conversation_history.append({"role": "assistant", "content": final_content})
                return final_content

            return assistant_message.content

        except Exception as e:
            err_str = str(e)
            err_msg = f"❌ **Error en la API de OpenRouter (`{target_model}`)**:\n{err_str}"
            if "AuthenticationError" in err_str or "401" in err_str:
                err_msg += "\n\n💡 *Verifica que tu OPENROUTER_API_KEY sea válida y tenga crédito.*"
            elif "429" in err_str:
                err_msg += "\n\n💡 *Se ha alcanzado el límite de peticiones de la API (Rate Limit).* "
            self.conversation_history.append({"role": "assistant", "content": err_msg})
            return err_msg