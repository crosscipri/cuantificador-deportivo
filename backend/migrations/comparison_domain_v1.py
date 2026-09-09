"""Additive migration with journal and selective restoration of unchanged links.

Default inventory. --apply writes. --run-id resumes a run. --rollback RUN_ID
inspects restoration; add --apply to restore links. Sources and evidence remain.
"""
import argparse
import asyncio
import os
import certifi
from dotenv import load_dotenv
from motor.motor_asyncio import AsyncIOMotorClient
from .comparison_journal import execute


async def migrate(args):
    load_dotenv()
    uri = os.getenv("MONGO_URL", "mongodb://localhost:27017")
    client = AsyncIOMotorClient(uri, serverSelectionTimeoutMS=5000, **({"tlsCAFile": certifi.where()} if uri.startswith("mongodb+srv://") else {}))
    db = client[os.getenv("DB_NAME", "hr_analyzer")]
    try:
        print(await execute(db,args.apply,args.run_id,args.rollback,args.hr_only))
    finally:
        client.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--run-id")
    parser.add_argument("--rollback",metavar="RUN_ID")
    parser.add_argument("--hr-only",action="store_true")
    args = parser.parse_args()
    asyncio.run(migrate(args))
