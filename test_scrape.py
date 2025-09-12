import asyncio
from app import fetch_jubilee

async def main():
    print("Calling fetch_jubilee()…")
    rows = await fetch_jubilee()
    print(f"Got {len(rows)} rows")
    for r in rows[:5]:  # show first 5
        print(r)

if __name__ == "__main__":
    asyncio.run(main())
