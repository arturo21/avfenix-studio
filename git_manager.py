import os
import git

class GitManager:
    def __init__(self, repo_path=None):
        self.repo_path = repo_path or os.getcwd()
        self.repo = None
        self.initialize_repo()

    def initialize_repo(self):
        """Attempts to load or initialize a git repository from the specified path."""
        try:
            if os.path.isdir(os.path.join(self.repo_path, ".git")):
                self.repo = git.Repo(self.repo_path)
            else:
                self.repo = git.Repo.init(self.repo_path)
            return {"status": "success", "message": "Git repository initialized"}
        except Exception as e:
            print(f"Error loading Git repository: {e}")
            self.repo = None
            return {"status": "error", "message": str(e)}

    def get_status(self):
        """Returns the current status of the Git repository including branches, changes, and commits ahead/behind."""
        if not self.repo:
            return {"is_repo": False, "error": "No git repository found"}

        try:
            active_branch = self.repo.active_branch.name
        except TypeError:
            active_branch = "Detached HEAD"
        except Exception:
            active_branch = "master"

        # Get status lists safely handling empty repos (unborn HEAD)
        try:
            changed_files = [item.a_path for item in self.repo.index.diff(None)]
        except Exception:
            changed_files = []

        try:
            staged_files = [item.a_path for item in self.repo.index.diff("HEAD")]
        except Exception:
            # Unborn HEAD before initial commit
            try:
                staged_files = [k[0] if isinstance(k, tuple) else k for k in self.repo.index.entries.keys()]
            except Exception:
                staged_files = []

        try:
            untracked_files = self.repo.untracked_files
        except Exception:
            untracked_files = []

        # Commits Ahead/Behind if tracking branch is present
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
            pass # No remote tracking branch or detached HEAD

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
        """Stages a specific file or files (equivalent to 'git add <file>')."""
        if not self.repo:
            raise Exception("No active Git repository")
        try:
            self.repo.git.add(file_path)
            return {"status": "success", "message": f"Staged {file_path}"}
        except Exception as e:
            return {"status": "error", "message": str(e)}

    def stage_all(self):
        """Stages all local changes (equivalent to 'git add .')."""
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
        """Pushes local commits to the remote repository (GitHub)."""
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
        """Pulls changes from the remote repository (GitHub) and merges them."""
        if not self.repo:
            raise Exception("No active Git repository")
        try:
            origin = self.repo.remote(name="origin")
            info = origin.pull()
            pull_details = [f"Summary: {i.note}" for i in info]
            return {"status": "success", "message": "\n".join(pull_details)}
        except Exception as e:
            return {"status": "error", "message": f"Pull failed: {str(e)}"}