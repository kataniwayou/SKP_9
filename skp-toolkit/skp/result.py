from dataclasses import dataclass, field

EXIT_OK = 0
EXIT_USAGE = 1
EXIT_NOT_INITIALISED = 2
EXIT_VERDICT = 3
EXIT_UNREACHABLE = 4
EXIT_DRIFT = 5


@dataclass
class Result:
    """What every verb returns.

    ``next_command`` is not decoration. A small model does not hold a plan across
    turns, so each verb names the one command that follows it.
    """

    code: int
    lines: list[str] = field(default_factory=list)
    next_command: str | None = None
    reference: str | None = None

    def render(self) -> str:
        out = list(self.lines)
        if self.reference:
            out.append(f"SEE: {self.reference}")
        if self.next_command:
            out.append(f"NEXT: {self.next_command}")
        return "\n".join(out)
