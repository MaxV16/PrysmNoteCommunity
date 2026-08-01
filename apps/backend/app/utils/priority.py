from __future__ import annotations


def normalize_priority(p: int | None) -> int:
    """Normalize to 3 tiers: 1=High(red), 2=Medium(blue), 3=Low(green).

    These are the canonical stored values. Legacy 1-5 values map: 1->1 (high),
    2->2 (medium), 3->3 (low), and anything >=4 (old low/none) folds to 3 (low).
    """
    if not p:
        return 2
    if p <= 1:
        return 1
    if p == 2:
        return 2
    return 3
