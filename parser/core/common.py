import re
from typing import List, Dict, Any, Optional

MONTH_MAP = {
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
    "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12
}

DATE_RE = re.compile(
    r"^(?:(?:\d+)[\.\)]?\s+)?"
    r"(?:"
    r"(\d{1,2})[\s\.\-]+([A-Za-z]{3})[\s\.\-]+(\d{4}|\d{2})|"  # 01 Jan 2026 / 01-Jan-26
    r"(\d{1,2})[\/\.\-](\d{1,2})[\/\.\-](\d{4}|\d{2})|"        # 22/10/2026 / 22-10-26
    r"(\d{4})[\/\.\-](\d{1,2})[\/\.\-](\d{1,2})"              # 2026-10-22
    r")\b",
    re.IGNORECASE
)

AMOUNT_RE = re.compile(r"^-?\d[\d,]*\.\d{1,2}$")

def get_word_attr(word: Any, attr: str, default: Any = 0.0) -> Any:
    if isinstance(word, dict):
        return word.get(attr, default)
    return getattr(word, attr, default)

def clean_whitespace(text: str) -> str:
    return " ".join(text.strip().split())

def parse_date(text: str) -> Optional[str]:
    clean = text.strip()
    m = DATE_RE.match(clean)
    if not m:
        return None

    if m.group(1) and m.group(2) and m.group(3):
        d = int(m.group(1))
        mon_str = m.group(2).lower()[:3]
        if mon_str not in MONTH_MAP:
            return None
        m_num = MONTH_MAP[mon_str]
        y = int(m.group(3))
        if y < 100:
            y += 2000
        if 1 <= d <= 31 and 1 <= m_num <= 12:
            return f"{y:04d}-{m_num:02d}-{d:02d}"

    elif m.group(4) and m.group(5) and m.group(6):
        d = int(m.group(4))
        m_num = int(m.group(5))
        y = int(m.group(6))
        if y < 100:
            y += 2000
        if 1 <= d <= 31 and 1 <= m_num <= 12:
            return f"{y:04d}-{m_num:02d}-{d:02d}"

    elif m.group(7) and m.group(8) and m.group(9):
        y = int(m.group(7))
        m_num = int(m.group(8))
        d = int(m.group(9))
        if 1 <= d <= 31 and 1 <= m_num <= 12:
            return f"{y:04d}-{m_num:02d}-{d:02d}"

    return None

def parse_amount(val_str: str) -> Optional[float]:
    s = val_str.strip().replace(",", "")
    if not s:
        return None

    mult = 1.0
    if s.upper().endswith("DR"):
        mult = -1.0
        s = s[:-2].strip()
    elif s.upper().endswith("CR"):
        s = s[:-2].strip()

    try:
        return round(float(s) * mult, 2)
    except ValueError:
        return None

class Line:
    def __init__(self, page: int, top: float, bottom: float):
        self.page = page
        self.top = top
        self.bottom = bottom
        self.words: List[Any] = []

    @property
    def text(self) -> str:
        # Sort words left-to-right
        sorted_words = sorted(self.words, key=lambda w: get_word_attr(w, "x0"))
        return clean_whitespace(" ".join(str(get_word_attr(w, "text", "")) for w in sorted_words))

def words_to_lines(words: List[Any], line_tolerance: float = 3.5) -> List[Line]:
    """
    Groups words into lines by page and top coordinate proximity.
    """
    if not words:
        return []

    # Sort words primarily by page, then by top coordinate
    sorted_words = sorted(
        words,
        key=lambda w: (get_word_attr(w, "page", 1), get_word_attr(w, "top", 0.0), get_word_attr(w, "x0", 0.0))
    )

    lines: List[Line] = []
    current_line: Optional[Line] = None

    for w in sorted_words:
        w_page = get_word_attr(w, "page", 1)
        w_top = get_word_attr(w, "top", 0.0)
        w_bottom = get_word_attr(w, "bottom", w_top)

        if current_line is None:
            current_line = Line(page=w_page, top=w_top, bottom=w_bottom)
            current_line.words.append(w)
        else:
            if w_page == current_line.page and abs(w_top - current_line.top) <= line_tolerance:
                current_line.words.append(w)
                current_line.bottom = max(current_line.bottom, w_bottom)
            else:
                lines.append(current_line)
                current_line = Line(page=w_page, top=w_top, bottom=w_bottom)
                current_line.words.append(w)

    if current_line is not None and current_line.words:
        lines.append(current_line)

    return lines
