"""
Sample Pipeline — Google Sheets Only
Flask · Google Sheets CRM · CORS enabled for deployed frontend
Task Reference: TASK_T04 (GO-BRICS Business Lab)
"""

import os, hmac, hashlib, json, logging
from datetime import datetime, timezone
from flask import Flask, request, jsonify
from flask_cors import CORS
from dotenv import load_dotenv
import gspread
from google.oauth2.service_account import Credentials

load_dotenv()
logging.basicConfig(
    filename="sample_pipeline.log",
    level=logging.INFO,
    format="%(asctime)s %(levelname)-8s %(name)s %(message)s"
)
log = logging.getLogger("sample_pipeline")

app = Flask(__name__)
CORS(app)   # allow requests from any deployed frontend origin

WEBHOOK_SECRET    = os.getenv("WEBHOOK_SECRET", "adishila_secret_key_2026")
GOOGLE_CREDS_JSON = os.getenv("GOOGLE_CREDS_JSON", "")   # full JSON string as env var
SPREADSHEET_ID    = os.getenv("SPREADSHEET_ID", "")
SHEET_NAME        = os.getenv("SHEET_NAME", "SampleCRM")

CRM_HEADERS = [
    "Date", "Ticket ID", "Request Type",
    "Name", "Business Name", "Business Type",
    "Phone", "Email", "GST Number",
    "Products Requested", "Total Units",
    "Status", "Prior Ticket ID", "Notes",
    "Pipeline Stage", "Comments"
]

def get_sheet():
    scopes = ["https://www.googleapis.com/auth/spreadsheets"]
    if GOOGLE_CREDS_JSON:
        import json as _json
        info = _json.loads(GOOGLE_CREDS_JSON)
        creds = Credentials.from_service_account_info(info, scopes=scopes)
    else:
        creds = Credentials.from_service_account_file("google_creds.json", scopes=scopes)
    client = gspread.authorize(creds)
    return client.open_by_key(SPREADSHEET_ID).worksheet(SHEET_NAME)

def ensure_headers(sheet):
    if sheet.row_values(1) != CRM_HEADERS:
        sheet.insert_row(CRM_HEADERS, 1)

def ticket_exists(sheet, ticket_id):
    return ticket_id in sheet.col_values(2)

def phone_or_email_exists(sheet, phone, email):
    for row in sheet.get_all_records():
        if phone and str(row.get("Phone", "")) == phone:
            return row.get("Ticket ID")
        if email and str(row.get("Email", "")).lower() == (email or "").lower():
            return row.get("Ticket ID")
    return None

def append_crm_row(sheet, data, status, stage):
    products_str = "; ".join(
        f"{p['name']} x{p['qty']}" for p in data.get("products", [])
    )
    total_units = sum(p.get("qty", 0) for p in data.get("products", []))
    sheet.append_row([
        datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        data["ticket_id"],
        data.get("event", "").replace("_", " ").title(),
        data.get("name", ""),
        data.get("business_name", ""),
        data.get("business_type", ""),
        data.get("phone", ""),
        data.get("email", ""),
        data.get("gst_number", ""),
        products_str,
        total_units,
        status,
        data.get("prior_ticket", ""),
        data.get("notes", ""),
        stage,
        "",   # Comments — filled manually by team
    ], value_input_option="USER_ENTERED")
    log.info("CRM row appended | ticket=%s | status=%s", data["ticket_id"], status)

def make_signature(payload: dict) -> str:
    return hmac.new(
        WEBHOOK_SECRET.encode(),
        json.dumps(payload, sort_keys=True).encode(),
        hashlib.sha256
    ).hexdigest()

def verify_signature(payload: dict) -> bool:
    received = payload.pop("signature", None)
    if not received:
        return False
    expected = make_signature(payload)
    payload["signature"] = received
    return hmac.compare_digest(received, expected)

# ── Main webhook ─────────────────────────────────────────────────────────────
@app.route("/webhook/sample", methods=["POST"])
def webhook_sample():
    data = request.get_json(force=True)
    if not data:
        return jsonify({"error": "No payload"}), 400

    ticket_id = data.get("ticket_id", "UNKNOWN")
    log.info("Webhook received | ticket=%s | event=%s", ticket_id, data.get("event"))

    # 1. HMAC check
    payload_copy = dict(data)
    if not verify_signature(payload_copy):
        log.warning("Invalid HMAC | ticket=%s", ticket_id)
        return jsonify({"error": "Invalid signature"}), 403

    # 2. Connect to Sheets
    try:
        sheet = get_sheet()
        ensure_headers(sheet)
    except Exception as e:
        log.error("Sheets connection failed | %s", e)
        return jsonify({"error": "CRM unavailable"}), 503

    # 3. Duplicate ticket guard
    if ticket_exists(sheet, ticket_id):
        log.warning("Duplicate blocked | ticket=%s", ticket_id)
        return jsonify({"status": "duplicate_blocked", "ticket_id": ticket_id}), 200

    # 4. Unreachable guard
    phone = data.get("phone", "")
    email = data.get("email", "")
    if not phone and not email:
        append_crm_row(sheet, data, "Unreachable", "Cold")
        return jsonify({"status": "unreachable", "ticket_id": ticket_id}), 200

    # 5. Returning customer detection
    existing = phone_or_email_exists(sheet, phone, email)
    if existing and not data.get("prior_ticket"):
        data["prior_ticket"] = existing
        status = "Reorder" if data.get("event") == "reorder" else "Recurring"
    else:
        status = "New"

    # 6. Priority classification
    is_priority = (
        data.get("event") in ("bulk_quote", "reorder") or
        data.get("business_type") == "Distributor" or
        any(p.get("qty", 0) >= 50 for p in data.get("products", []))
    )
    stage = "Warm" if is_priority else "Cold"

    # 7. Write to Sheets
    append_crm_row(sheet, data, status, stage)

    log.info("Processed OK | ticket=%s | status=%s | priority=%s", ticket_id, status, is_priority)
    return jsonify({
        "status": "ok",
        "ticket_id": ticket_id,
        "crm_status": status,
        "priority": is_priority
    }), 200

@app.route("/ping")
def ping():
    return jsonify({"status": "ok", "mode": "sheets_only_deployed"})

if __name__ == "__main__":
    port = int(os.getenv("PORT", 5001))
    app.run(host="0.0.0.0", port=port)
