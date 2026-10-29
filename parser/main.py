import os
import asyncio
import logging
from typing import Optional

from fastapi import FastAPI, UploadFile, File, Form, Header, Request, HTTPException
from fastapi.responses import JSONResponse

from core import (
    parse_words,
    extract_words_from_pdf,
    PasswordRequiredException,
    ParseResponse
)

# Configure sanitized logger: error types only, NEVER log customer or txn data
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("parser")

app = FastAPI(title="Bank Statement Parser Service", version="1.0.0")

# Concurrency lock for memory limit protection (single-worker execution)
parse_lock = asyncio.Lock()

MAX_FILE_SIZE = 10 * 1024 * 1024  # 10 MB

@app.get("/health")
async def health_check():
    return {"status": "ok"}

@app.post("/parse", response_model=ParseResponse)
async def parse_statement(
    request: Request,
    file: UploadFile = File(...),
    password: Optional[str] = Form(None),
    x_api_key: Optional[str] = Header(None, alias="X-API-Key")
):
    # 1. API Key Auth: If PARSER_KEY env is set, enforce strict match
    expected_key = os.getenv("PARSER_KEY", "").strip()
    if expected_key:
        if not x_api_key or x_api_key.strip() != expected_key:
            logger.warning("[AUTH] Unauthorized request: missing or invalid X-API-Key")
            return JSONResponse(
                status_code=401,
                content={"detail": "Unauthorized: Invalid or missing API key."}
            )

    # 2. Validate PDF format (415)
    filename = (file.filename or "").lower()
    content_type = (file.content_type or "").lower()
    is_pdf = content_type == "application/pdf" or filename.endswith(".pdf")
    if not is_pdf:
        logger.warning("[VALIDATION] Non-PDF upload rejected")
        return JSONResponse(
            status_code=415,
            content={"detail": "Unsupported Media Type: Only PDF files are supported."}
        )

    # 3. Read in-memory and validate file size (413)
    try:
        pdf_bytes = await file.read()
    except Exception as e:
        logger.error(f"[READ ERROR] Failed to read uploaded file: {type(e).__name__}")
        return JSONResponse(status_code=400, content={"detail": "Failed to read upload payload."})

    if len(pdf_bytes) > MAX_FILE_SIZE:
        logger.warning("[VALIDATION] File size exceeded 10 MB limit")
        return JSONResponse(
            status_code=413,
            content={"detail": "Payload Too Large: File size exceeds the 10 MB limit."}
        )

    # 4. Process within concurrency lock
    async with parse_lock:
        try:
            words = extract_words_from_pdf(pdf_bytes, password=password)
        except PasswordRequiredException:
            logger.info("[AUTH] Password required or incorrect")
            return JSONResponse(
                status_code=401,
                content={"detail": "PDF password required or incorrect.", "needPassword": True}
            )
        except Exception as e:
            logger.error(f"[EXTRACT ERROR] Extraction failed: {type(e).__name__}")
            return JSONResponse(
                status_code=500,
                content={"detail": "Failed to parse PDF document structure."}
            )

        try:
            parsed = parse_words(words)
        except Exception as e:
            logger.error(f"[PARSE ERROR] Processing failed: {type(e).__name__}")
            return JSONResponse(
                status_code=500,
                content={"detail": "Failed to extract transaction data."}
            )

        if len(parsed.txns) == 0:
            logger.warning(f"[EMPTY RESULT] Profile {parsed.profile} extracted 0 transactions")
            return JSONResponse(
                status_code=422,
                content={"detail": "Unprocessable Entity: No transactions could be extracted from statement."}
            )

        logger.info(
            f"[PARSE SUCCESS] profile={parsed.profile}, count={len(parsed.txns)}, "
            f"ok={parsed.quality.ok}, mismatches={parsed.quality.mismatches}"
        )
        return parsed

if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", "8000"))
    uvicorn.run("main:app", host="0.0.0.0", port=port)
