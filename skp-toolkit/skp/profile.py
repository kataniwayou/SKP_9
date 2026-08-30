import json
import os
import pathlib
from dataclasses import asdict, dataclass, field

from skp.result import EXIT_NOT_INITIALISED, Result

TOKEN_MASK = "<token from profile>"


class ProfileMissing(Exception):
    """No memory folder here yet. The caller should return ``not_initialised()``."""


def default_home() -> pathlib.Path:
    return pathlib.Path.home() / ".skp"


def redact(text: str, token: str) -> str:
    """Replace the token wherever it appears. Called on every rendered string."""
    if not token:
        return text
    return text.replace(token, TOKEN_MASK)


def not_initialised() -> Result:
    return Result(
        EXIT_NOT_INITIALISED,
        ["no memory folder — this machine has not been initialised"],
        next_command="skp init",
    )


@dataclass
class Profile:
    home: pathlib.Path
    source_root: str
    cluster_url: str
    project: str
    endpoints: dict[str, str] = field(default_factory=dict)

    # ---- persistence -------------------------------------------------

    def save(self, token: str) -> None:
        """Write the profile and, separately, the token.

        The token lives in its own file so that ``profile.json`` can be read,
        pasted and diffed freely. ``chmod`` is best-effort: on Windows it only
        toggles the read-only bit, so the separation — not the mode — is what
        carries the guarantee.
        """
        self.home.mkdir(parents=True, exist_ok=True)
        for sub in ("model", "state", "cases"):
            (self.home / sub).mkdir(exist_ok=True)

        body = asdict(self)
        body["home"] = str(self.home)
        (self.home / "profile.json").write_text(
            json.dumps(body, indent=2, sort_keys=True), encoding="utf-8")

        token_path = self.home / "token"
        token_path.write_text(token, encoding="utf-8")
        try:
            os.chmod(token_path, 0o600)
        except OSError:
            pass

    @classmethod
    def load(cls, home: pathlib.Path | None = None) -> "Profile":
        home = home or default_home()
        path = home / "profile.json"
        if not path.exists():
            raise ProfileMissing(str(path))
        body = json.loads(path.read_text(encoding="utf-8"))
        return cls(
            home=pathlib.Path(body["home"]),
            source_root=body["source_root"],
            cluster_url=body["cluster_url"],
            project=body["project"],
            endpoints=body.get("endpoints", {}),
        )

    # ---- accessors ---------------------------------------------------

    @property
    def token(self) -> str:
        path = self.home / "token"
        return path.read_text(encoding="utf-8") if path.exists() else ""

    def redact(self, text: str) -> str:
        return redact(text, self.token)
