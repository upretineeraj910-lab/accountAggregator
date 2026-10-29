from typing import Optional, List, Literal
from pydantic import BaseModel, Field

ProfileType = Literal["axis", "icici", "pnb", "generic"]

class Txn(BaseModel):
    date: str  # YYYY-MM-DD
    narration: str
    debit: float
    credit: float
    balance: float

class Holder(BaseModel):
    name: Optional[str] = None
    branch: Optional[str] = None
    accountNo: Optional[str] = None
    ifsc: Optional[str] = None

class Quality(BaseModel):
    ok: bool
    mismatches: int
    total: int
    firstRowUncertain: bool

class ParseResponse(BaseModel):
    profile: ProfileType
    txns: List[Txn]
    holder: Holder
    quality: Quality

class Word(BaseModel):
    text: str
    x0: float = 0.0
    x1: float = 0.0
    top: float = 0.0
    bottom: float = 0.0
    page: int = 1
