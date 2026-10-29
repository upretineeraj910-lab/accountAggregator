# Statement Check PDF Parser Microservice

Lightweight Python 3.11+ FastAPI microservice dedicated to bank statement PDF extraction for LoanSaarthi.

## Key Features & Constraints
- **Zero AI / Zero OCR**: Deterministic text and coordinate parsing powered by `pdfplumber`.
- **Zero Disk Writes**: PDF processing occurs strictly in-memory (`io.BytesIO`).
- **Privacy & Sanitized Logging**: Transaction descriptions, amounts, and customer names are **never logged** (only error types, profiles, and counts are recorded).
- **Concurrency & Memory Guard**: Protected by an `asyncio.Lock()` and configured for single-worker execution to prevent memory spikes on free/starter cloud tiers.
- **Supported Profiles**: PNB (PNB ONE), Axis Bank, ICICI Bank, and Generic statements.

---

## API Endpoints

### 1. Health Check
- **`GET /health`**
- **Response**: `{"status": "ok"}`

### 2. Parse Statement
- **`POST /parse`**
- **Content-Type**: `multipart/form-data`
- **Headers**:
  - `X-API-Key`: (Optional if `PARSER_KEY` is not set; required if `PARSER_KEY` is configured). Returns `401` if mismatched.
- **Form Fields**:
  - `file`: PDF file binary (`application/pdf`).
  - `password`: (Optional) PDF password string.
- **HTTP Status Codes**:
  - `200`: Success.
  - `401`: Unauthorized (wrong API key) or password required (`{"detail": "PDF password required or incorrect.", "needPassword": true}`).
  - `413`: File size exceeds 10 MB limit.
  - `415`: Non-PDF file submitted.
  - `422`: Unprocessable entity (0 transactions extracted).
  - `500`: PDF parsing or format error.
- **Response JSON**:
```json
{
  "profile": "pnb",
  "txns": [
    {
      "date": "2026-10-20",
      "narration": "UPI/DR/165240394537/Axis Ban/UTIB/billpay.axb@upi/",
      "debit": 700.0,
      "credit": 0.0,
      "balance": 1654.93
    }
  ],
  "holder": {
    "name": "ABC DEF",
    "branch": "MATIA",
    "accountNo": "12345678901234",
    "ifsc": "PUNB0123456"
  },
  "quality": {
    "ok": true,
    "mismatches": 0,
    "total": 1,
    "firstRowUncertain": false
  }
}
```

---

## Local Development & Testing

```bash
# Install dependencies
pip install -r parser/requirements.txt

# Run pytest unit tests (100% synthetic word lists, zero real customer data)
python -m pytest parser/tests

# Run local development server
uvicorn main:app --app-dir parser --reload --port 8000
```

---

## Cloud Deployment

### Deploying to Render
1. Create a new **Web Service** in Render.
2. Select your repository.
3. Configure the service settings:
   - **Root Directory**: `parser`
   - **Environment**: `Docker` (or `Python 3`)
   - **Build Command**: `pip install -r requirements.txt` (if using Python environment)
   - **Start Command**: `uvicorn main:app --host 0.0.0.0 --port $PORT --workers 1`
4. In **Environment Variables**:
   - `PARSER_KEY`: Set your secret API key (e.g. `ls_parser_live_abc123`).

### Deploying to Railway
1. Create a new project in Railway and select **Deploy from GitHub repo**.
2. Go to **Service Settings** -> **Source**:
   - Set **Root Directory** to `/parser`.
3. In **Variables**:
   - Set `PARSER_KEY`: Your secret API key.
4. Railway will automatically pick up the `Dockerfile` and expose the service via `$PORT`.

---

## Next.js Integration
In the Next.js `.env.local` configuration:
```env
PARSER_URL=https://your-service.onrender.com
PARSER_KEY=ls_parser_live_abc123
```
If `PARSER_URL` and `PARSER_KEY` are configured, Next.js `/api/analyze` will delegate PDF parsing to this Python microservice, seamlessly falling back to the TypeScript parser if the service is unreachable.
