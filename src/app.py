import os
import json
import time
import uuid
import boto3
import base64
from datetime import datetime
from zoneinfo import ZoneInfo  # Python 3.9+ for timezone handling

# === ENV VARIABLES (configure in Lambda console) ===
REGION = os.environ.get("AWS_REGION", "us-east-1")
LLM_MODEL_ID = os.environ.get("LLM_MODEL_ID", "anthropic.claude-3-5-sonnet-20240620-v1:0")
DDB_TABLE = os.environ.get("DDB_TABLE", "conversation_history_rnd")
PRODUCT = os.environ.get("PRODUCT", "benefit-assist")
PDF_S3_BUCKET = "usthp-rnd-ai-benefitassist"
PDF_S3_KEY = "input/Wellmark-Avera Blue Medicare Advantage PPO Iowa-ppo-evidence-of-coverage.pdf"

# Clients
dynamodb = boto3.resource("dynamodb", region_name=REGION)
table = dynamodb.Table(DDB_TABLE)
brt = boto3.client("bedrock-runtime", region_name=REGION)
s3 = boto3.client("s3", region_name=REGION)


def get_pdf_base64(bucket: str, key: str) -> str:
    """Download PDF from S3 and return base64-encoded string."""
    try:
        obj = s3.get_object(Bucket=bucket, Key=key)
        pdf_bytes = obj["Body"].read()
        return base64.b64encode(pdf_bytes).decode("utf-8")
    except Exception as e:
        return f"Error encoding PDF: {str(e)}"


def lambda_handler(event, context):
    start_time = time.time()

    # --- Extract request payload ---
    user_id = event.get("userID", "unknown-user")
    email = event.get("email", "unknown@example.com")
    chat_name = event.get("chatName", "default-chat")
    query = event.get("query", "Hello, test prompt.")

    # --- Get PDF as Base64 ---
    pdf_base64 = get_pdf_base64(PDF_S3_BUCKET, PDF_S3_KEY)

    session_id = str(uuid.uuid4())

    # --- Retrieved chunks (replace with actual retrieval pipeline) ---
    retrieved_chunks = [
        {
            "planName": "Wellmark-Iowa",
            "pdfSource": pdf_base64,
            "chunks": [
                {
                    "chunk_id": "chunk-id-001",
                    "text": "Telehealth services are covered with $0 copay for in-network providers.",
                    "start_page": 65,
                    "end_page": 65,
                },
                {
                    "chunk_id": "chunk-id-002",
                    "text": "Out-of-network telehealth visits may have higher cost sharing.",
                    "start_page": 77,
                    "end_page": 77,
                }
            ],
        },
        {
            "planName": "Wellmark-SouthDakota",
            "pdfSource": pdf_base64,
            "chunks": [
                {
                    "chunk_id": "chunk-id-003",
                    "text": "Telehealth services limited to urgent care and behavioral health.",
                    "start_page": 44,
                    "end_page": 44,
                }
            ],
        }
    ]

    # --- Use the retrieved chunks as context for LLM ---
    # Flatten the chunks into text for the prompt
    context_texts = []
    for ref in retrieved_chunks:
        for c in ref["chunks"]:
            context_texts.append(f"[{ref['planName']}, p.{c['start_page']}] {c['text']}")
    context_str = "\n".join(context_texts)

    # --- Build system & user messages ---
    system_msg = """
    You are a professional healthcare benefits advisor with expertise in Medicare Advantage plans.
    Your role is to carefully interpret and explain coverage details from plan documents to users in a way that is precise, structured, and easy to understand.
    """

    user_prompt = f"User query:\n{query}\n\n### Retrieved Context\n{context_str}"

    # --- Prepare request payload for Bedrock ---
    req = {
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": 512,
        "temperature": 0.2,
        "system": [{"type": "text", "text": system_msg}],
        "messages": [{"role": "user", "content": [{"type": "text", "text": user_prompt}]}],
    }

    # --- Call Bedrock ---
    error_block = None
    try:
        resp = brt.invoke_model(
            modelId=LLM_MODEL_ID,
            contentType="application/json",
            accept="application/json",
            body=json.dumps(req),
        )
        result = json.loads(resp["body"].read())
        answer = result["content"][0]["text"]
        status = "SUCCESS"
    except Exception as e:
        answer = ""
        status = "FAILED"
        error_block = {"code": e.__class__.__name__, "message": str(e)}

    # --- Store into DynamoDB ---
    elapsed_time = round(time.time() - start_time, 2)
    timestamp_est = datetime.now(ZoneInfo("America/New_York")).isoformat()

    conversation_id = str(uuid.uuid4())
    item = {
        "id": conversation_id,
        "sessionId": session_id,
        "userId": user_id,
        "email": email,
        "chatName": chat_name,
        "query": query,
        "response": answer,
        "timestamp": timestamp_est,
        "product": PRODUCT,
        "elapsedTime": str(elapsed_time),
    }

    try:
        table.put_item(Item=item)
    except Exception as e:
        return {
            "statusCode": 500,
            "body": json.dumps({"error": f"Failed to write to DynamoDB: {str(e)}"}),
        }

    # --- Build final response (retrieved chunks used both ways) ---
    response_payload = {
        "conversationId": conversation_id,
        "query": query,
        "status": status,
        "response": answer,
        "elapsedTime": elapsed_time,
        "timestamp": timestamp_est,
        "error": error_block,
        "references": retrieved_chunks,
    }

    return {
        "statusCode": 200,
        "body": json.dumps(response_payload),
    }
