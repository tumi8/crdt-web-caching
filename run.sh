#!/bin/bash

set -euo pipefail 

node=TODO

run_experiment() {
	location=$1
	api_endpoint=$2
	api_mode=$3
	host=$4
	echo "Running experiments for $api_endpoint and $api_mode on $host"
	echo "[TODO] configure a clean ubuntu-focal image on host $host"
	echo "ssh $host git clone https://github.com/tumi8/crdt-web-caching.git"
	echo "ssh $host cdn-crdt-api/setup.sh"
	echo "ssh $host cdn-crdt-api/experiment.sh $location $api_endpoint $api_mode"
}


for api_endpoint in flights forums; do
	for api_mode in crdt cache proxy ttl; do
		run_experiment . $api_endpoint $api_mode $node
	done
done
