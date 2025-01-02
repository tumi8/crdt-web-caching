#!/usr/bin/env bash

set -eux

redis-server --port $REDIS_PORT --maxmemory 2gb --maxmemory-policy volatile-lru --notify-keyspace-events Ex --save "" --appendonly no