#!/bin/bash

set -euo pipefail

cd "$(dirname "$0")"

OUT_DIR=$1
API_ENDPOINT=$2
API_MODE=$3

if [[ -z "$OUT_DIR" ]]; then
	echo "TARGET directory not set: $0 TARGET_DIR"
	exit 1
fi

API_ENDPOINT=${API_ENDPOINT:-flights}
API_MODE=${API_MODE:-proxy}

set -x

source mininet/.venv/bin/activate

mininet/main.py --api $API_ENDPOINT --mode $API_MODE --log-dir $OUT_DIR/$API_ENDPOINT/$API_MODE --scale-size 1 --scale-interval 60 --scale-times 100

echo "results available under $OUT_DIR/$API_ENDPOINT/$API_MODE"
# pos_upload -fr $OUT_DIR/$API_ENDPOINT/$API_MODE

