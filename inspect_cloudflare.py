import os
import json
import urllib.request
import urllib.parse
from pathlib import Path

API = "https://api.cloudflare.com/client/v4"


def load_env():
    path = Path(".env")
    if not path.exists():
        raise SystemExit(".env neexistuje")

    for line in path.read_text().splitlines():
        line = line.strip()

        if not line or line.startswith("#") or "=" not in line:
            continue

        key, value = line.split("=", 1)
        os.environ.setdefault(
            key.strip(),
            value.strip().strip('"').strip("'")
        )


def api(path, token):
    req = urllib.request.Request(
        API + path,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json"
        }
    )

    with urllib.request.urlopen(req) as response:
        data = json.loads(response.read())

    if not data.get("success"):
        raise RuntimeError(data)

    return data["result"]


def main():
    load_env()

    token = os.getenv("CFAT")

    if not token:
        raise SystemExit("CFAT nie je nastavený v .env")

    print("\n========== CLOUDFLARE INVENTORY ==========\n")

    # Accounts
    accounts = api("/accounts", token)

    print("ACCOUNTS:")
    for account in accounts:
        print(f"  Name: {account.get('name')}")
        print(f"  ID:   {account.get('id')}")
        print()

    # Zones
    zones = api(
        "/zones?" + urllib.parse.urlencode({
            "name": "newlevel.church"
        }),
        token
    )

    print("\nZONES:")

    for zone in zones:
        zone_id = zone["id"]

        print(f"  Domain:     {zone.get('name')}")
        print(f"  Zone ID:    {zone_id}")
        print(f"  Status:     {zone.get('status')}")
        print(f"  Account ID: {zone.get('account', {}).get('id')}")
        print(
            f"  Account:    "
            f"{zone.get('account', {}).get('name')}"
        )

        print("\n  Nameservers:")
        for ns in zone.get("name_servers", []):
            print(f"    {ns}")

        # DNS
        print("\n  DNS records:")
        records = api(
            f"/zones/{zone_id}/dns_records?per_page=100",
            token
        )

        for record in records:
            print(
                f"    {record.get('type'):6} "
                f"{record.get('name')} "
                f"→ {record.get('content')} "
                f"(proxied={record.get('proxied')})"
            )

        # Worker routes
        print("\n  Worker routes:")

        try:
            routes = api(
                f"/zones/{zone_id}/workers/routes",
                token
            )

            for route in routes:
                print(
                    f"    {route.get('pattern')} "
                    f"→ {route.get('script')}"
                )

            if not routes:
                print("    none")

        except Exception as e:
            print(f"    unavailable: {e}")

        print()

    # Account scoped resources
    for account in accounts:
        account_id = account["id"]

        print(
            f"\n========== ACCOUNT "
            f"{account.get('name')} =========="
        )

        # Pages
        print("\nPAGES PROJECTS:")

        try:
            projects = api(
                f"/accounts/{account_id}/pages/projects",
                token
            )

            for project in projects:
                print(f"\n  Project: {project.get('name')}")
                print(
                    f"  Production branch: "
                    f"{project.get('production_branch')}"
                )

                print(
                    f"  Subdomain: "
                    f"{project.get('subdomain')}"
                )

                domains = project.get("domains", [])

                print("  Domains:")
                for domain in domains:
                    print(f"    {domain}")

                source = project.get("source")

                if source:
                    print("  Git source:")
                    print(
                        json.dumps(
                            source,
                            indent=4
                        )
                    )

            if not projects:
                print("  none")

        except Exception as e:
            print(f"  unavailable: {e}")

        # Workers
        print("\nWORKERS:")

        try:
            workers = api(
                f"/accounts/{account_id}/workers/scripts",
                token
            )

            for worker in workers:
                print(
                    f"  {worker.get('id')}"
                )

            if not workers:
                print("  none")

        except Exception as e:
            print(f"  unavailable: {e}")

    print("\n==========================================")
    print("DONE")
    print("==========================================\n")


if __name__ == "__main__":
    main()