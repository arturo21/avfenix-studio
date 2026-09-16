import json
import os
import re
import httpx
from openai import OpenAI
from git_manager import GitManager

def load_env_file(env_path=".env"):
    """Reads .env file if present and populates os.environ if key is missing or default."""
    if os.path.exists(env_path):
        try:
            with open(env_path, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line and not line.startswith("#") and "=" in line:
                        k, v = line.split("=", 1)
                        k = k.strip()
                        v = v.strip().strip("'").strip('"')
                        if k:
                            os.environ[k] = v
        except Exception as e:
            print(f"Error loading {env_path}: {e}")

def get_openrouter_api_key():
    """Retrieves OPENROUTER_API_KEY from python-dotenv, manual .env parsing, or os.environ."""
    try:
        from dotenv import load_dotenv
        load_dotenv()
    except ImportError:
        pass

    # Check local .env files
    for path in [".env", os.path.join(os.getcwd(), ".env")]:
        load_env_file(path)

    key = os.getenv("OPENROUTER_API_KEY", "").strip()
    if key == "your-openrouter-key":
        key = ""
    return key

class AIAgent:
    def __init__(self, api_key=None, base_url="https://openrouter.ai/api/v1", model="openrouter/free"):
        env_key = get_openrouter_api_key()
        self.api_key = api_key or env_key or ""
        self.base_url = base_url
        self.model = "openrouter/free"
        self.client = None
        self.conversation_history = []
        self.git_manager = GitManager()
        self.setup_client()
        self.init_system_prompt()

    def setup_client(self):
        """Initializes or updates the OpenAI client with OpenRouter's base URL and credentials."""
        current_key = get_openrouter_api_key() or self.api_key or "dummy-key-for-init"
        self.client = OpenAI(
            base_url=self.base_url,
            api_key=current_key,
            default_headers={
                "HTTP-Referer": "https://avfenix-studio.org",
                "X-Title": "AVFenix Studio IDE"
            }
        )

    def init_system_prompt(self):
        """Initializes the system prompt directing the AI agent on its roles and constraints."""
        self.conversation_history = [
            {
                "role": "system",
                "content": (
                    "You are AVFenix Copilot, an advanced AI programming assistant embedded within a GTK-based Linux IDE.\n"
                    "You can read and propose modifications to the codebase. When modifying files or deleting them, "
                    "your proposals will be shown to the user visually via a Monaco Diff Editor or a GTK confirmation dialog.\n"
                    "Be precise, write clean modular code, and explain your changes concisely."
                )
            }
        ]

    def get_tools_definition(self):
        """Returns the function definitions for OpenRouter Tool Calling (Function Calling)."""
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
                    "description": "Proposes a new file or modifications to an existing file. This triggers a visual Monaco Diff comparison for user approval before writing.",
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
                    "description": "Proposes the deletion of a file. This triggers a native GTK Dialog confirming the action.",
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
                    "description": "Lists all directories and files in the project workspace to understand its layout.",
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
                    "description": "Queries the current local Git repository status (active branch, staged files, modified/untracked files, and commits ahead/behind).",
                    "parameters": {
                        "type": "object",
                        "properties": {}
                    }
                }
            }
        ]

    async def execute_tool(self, name, args, ws_callback):
        """Executes the specific tool called by the model. 
        If it is a write/delete proposal, it routes the proposal through the websocket callback."""
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
                "message": f"Deletion of {filepath} was requested. A native GTK confirmation dialog has been triggered for the user."
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

    async def chat(self, user_message, ws_callback, model=None, context=None, **kwargs):
        """Sends a message to OpenRouter, processes possible function/tool calls, 
        and updates the local conversation history."""
        
        # Check and dynamically reload API Key from .env or environment
        current_key = get_openrouter_api_key() or self.api_key
        if not current_key:
            err_msg = (
                "⚠️ **OPENROUTER_API_KEY no configurada.**\n\n"
                "Para solucionar el error de autenticación (401), agrega tu clave en el archivo `.env` en la raíz de tu proyecto:\n"
                "```env\nOPENROUTER_API_KEY=tu-clave-de-openrouter-aqui\n```\n"
                "O expórtala en la terminal antes de iniciar la aplicación:\n"
                "```bash\nexport OPENROUTER_API_KEY=\"tu-clave-de-openrouter-aqui\"\n```"
            )
            self.conversation_history.append({"role": "assistant", "content": err_msg})
            return err_msg

        # Ensure client uses current valid key
        self.client.api_key = current_key

        # Enforce openrouter/free model
        active_model = model or self.model or "openrouter/free"
        if "free" not in active_model:
            active_model = "openrouter/free"

        # Format message with Active Tab Context if present
        final_prompt = user_message
        if context and isinstance(context, dict) and (context.get("filepath") or context.get("file")):
            filepath = context.get("filepath") or context.get("file")
            content = context.get("content", "")
            language = context.get("language", "plaintext")
            final_prompt = (
                f"📌 [CONTEXTO DE LA PESTAÑA ACTIVA: {filepath}]\n"
                f"Lenguaje: `{language}`\n"
                f"```{language}\n{content}\n```\n\n"
                f"💬 Consulta del usuario: {user_message}"
            )

        self.conversation_history.append({"role": "user", "content": final_prompt})

        try:
            response = self.client.chat.completions.create(
                model=active_model,
                messages=self.conversation_history,
                tools=self.get_tools_definition(),
                tool_choice="auto"
            )

            assistant_message = response.choices[0].message
            self.conversation_history.append(assistant_message)

            if assistant_message.tool_calls:
                for tool_call in assistant_message.tool_calls:
                    name = tool_call.function.name
                    raw_args = getattr(tool_call.function, "arguments", "{}") or "{}"
                    if isinstance(raw_args, str):
                        args = json.loads(raw_args) if raw_args.strip() else {}
                    else:
                        args = raw_args
                    
                    result = await self.execute_tool(name, args, ws_callback)
                    
                    self.conversation_history.append({
                        "role": "tool",
                        "tool_call_id": tool_call.id,
                        "name": name,
                        "content": json.dumps(result)
                    })

                second_response = self.client.chat.completions.create(
                    model=active_model,
                    messages=self.conversation_history
                )
                final_content = second_response.choices[0].message.content
                self.conversation_history.append({"role": "assistant", "content": final_content})
                return final_content

            return assistant_message.content

        except Exception as e:
            err_msg = f"API Error: {str(e)}"
            self.conversation_history.append({"role": "assistant", "content": err_msg})
            return err_msg