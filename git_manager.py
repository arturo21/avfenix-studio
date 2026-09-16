import os
import git

class GitManager:
    def __init__(self, repo_path=None):
        self.repo_path = repo_path or os.getcwd()
        self.repo = None
        self.initialize_repo()

    def initialize_repo(self):
        """Attempts to load a git repository from the specified path."""
        try:
            if os.path.isdir(os.path.join(self.repo_path, ".git")):
                self.repo = git.Repo(self.repo_path)
            else:
                self.repo = None
        except Exception as e:
            print(f"Error loading Git repository: {e}")
            self.repo = None

    def get_status(self):
        """Returns current status handling clean and empty repositories safely."""
        if not self.repo:
            return {"is_repo": False, "error": "No git repository found"}

        try:
            active_branch = self.repo.active_branch.name
        except TypeError:
            active_branch = "Detached HEAD"
        except Exception:
            active_branch = "Unknown"

        changed_files = [item.a_path for item in self.repo.index.diff(None)]
        try:
            staged_files = [item.a_path for item in self.repo.index.diff("HEAD")]
        except Exception:
            # Handle unborn HEAD on newly initialized empty repositories
            staged_files = []

        untracked_files = self.repo.untracked_files

        ahead = 0
        behind = 0
        try:
            tracking_branch = self.repo.active_branch.tracking_branch()
            if tracking_branch:
                ahead_commits = list(self.repo.iter_commits(f"{tracking_branch.name}..{active_branch}"))
                behind_commits = list(self.repo.iter_commits(f"{active_branch}..{tracking_branch.name}"))
                ahead = len(ahead_commits)
                behind = len(behind_commits)
        except Exception:
            pass

        return {
            "is_repo": True,
            "branch": active_branch,
            "modified": changed_files,
            "staged": staged_files,
            "untracked": untracked_files,
            "ahead": ahead,
            "behind": behind
        }

    def stage_file(self, file_path):
        """Stages a specific file."""
        if not self.repo:
            raise Exception("No active Git repository")
        try:
            self.repo.git.add(file_path)
            return {"status": "success", "message": f"Staged {file_path}"}
        except Exception as e:
            return {"status": "error", "message": str(e)}

    def stage_all(self):
        """Stages all local changes."""
        if not self.repo:
            raise Exception("No active Git repository")
        try:
            self.repo.git.add(A=True)
            return {"status": "success", "message": "Staged all changes"}
        except Exception as e:
            return {"status": "error", "message": str(e)}

    def commit(self, message):
        """Creates a Git commit with the specified message."""
        if not self.repo:
            raise Exception("No active Git repository")
        try:
            new_commit = self.repo.index.commit(message)
            return {"status": "success", "message": f"Committed: {new_commit.hexsha[:7]}", "hash": new_commit.hexsha}
        except Exception as e:
            return {"status": "error", "message": str(e)}

    def push(self):
        """Pushes local commits to the remote repository."""
        if not self.repo:
            raise Exception("No active Git repository")
        try:
            origin = self.repo.remote(name="origin")
            info = origin.push()
            push_details = [f"Summary: {i.summary}" for i in info]
            return {"status": "success", "message": "\n".join(push_details)}
        except Exception as e:
            return {"status": "error", "message": f"Push failed: {str(e)}"}

    def pull(self):
        """Pulls changes from the remote repository."""
        if not self.repo:
            raise Exception("No active Git repository")
        try:
            origin = self.repo.remote(name="origin")
            info = origin.pull()
            pull_details = [f"Summary: {i.note}" for i in info]
            return {"status": "success", "message": "\n".join(pull_details)}
        except Exception as e:
            return {"status": "error", "message": f"Pull failed: {str(e)}"}