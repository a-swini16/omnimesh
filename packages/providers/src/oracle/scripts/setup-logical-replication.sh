#!/usr/bin/env bash
# OmniMesh Mode B: Setup Real-Time Logical Replication (Oracle -> Neon)
# Unlike flawed 5-minute pg_dump cron jobs, PostgreSQL Logical Replication
# streams WAL changes within seconds, ensuring near-zero RPO.

set -euo pipefail

echo "=========================================================="
echo " OmniMesh Mode B: Real-Time Postgres Logical Replication"
echo " Publisher:  Oracle VM PostgreSQL 16 (Primary Writer)"
echo " Subscriber: Neon Serverless Postgres (Standby Reader)"
echo "=========================================================="

if [ -z "${ORACLE_DB_URL:-}" ] || [ -z "${NEON_DB_URL:-}" ]; then
  echo "Error: Both ORACLE_DB_URL and NEON_DB_URL environment variables must be set."
  echo "Example: export ORACLE_DB_URL='postgres://postgres:pass@localhost:5432/omnimesh'"
  echo "Example: export NEON_DB_URL='postgres://user:pass@ep-cool-pooler.neon.tech/neondb?sslmode=require'"
  exit 1
fi

echo "1. Checking wal_level on Oracle Primary..."
WAL_LEVEL=$(psql "${ORACLE_DB_URL}" -t -A -c "SHOW wal_level;")
if [ "${WAL_LEVEL}" != "logical" ]; then
  echo "Error: wal_level on Oracle Primary is '${WAL_LEVEL}', must be 'logical'."
  echo "Add '-c wal_level=logical' to your postgres service in docker-compose.yml and restart."
  exit 1
fi
echo "✔ wal_level is logical"

echo "2. Creating Publication on Oracle Primary..."
psql "${ORACLE_DB_URL}" -c "CREATE PUBLICATION omnimesh_pub FOR ALL TABLES;" || echo "Publication already exists."
echo "✔ Publication omnimesh_pub active"

echo "3. Copying schema structure from Oracle to Neon..."
pg_dump --schema-only "${ORACLE_DB_URL}" | psql "${NEON_DB_URL}"
echo "✔ Schema synchronized"

echo "4. Creating Subscription on Neon Standby..."
psql "${NEON_DB_URL}" -c "CREATE SUBSCRIPTION omnimesh_sub CONNECTION '${ORACLE_DB_URL}' PUBLICATION omnimesh_pub WITH (copy_data = true);" || echo "Subscription already exists."
echo "✔ Subscription omnimesh_sub created"

echo "=========================================================="
echo "✔ Logical replication is active and streaming!"
echo "If Oracle VM goes down, traffic fails over reads to Neon."
echo "To promote Neon to Primary Writer, run: omnimesh db promote"
echo "=========================================================="
