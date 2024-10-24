#!/usr/bin/env tsx

import express, { Express, Request, Response } from "express";
import http from 'http';
import dotenv from "dotenv";
import proxy from "express-http-proxy"
import cors from 'cors';
import {HTTPCache} from './http-cache/cache.js';
import {CRDTCache} from "./crdts/crdts.js";
import {spawn} from "node:child_process";
import nocache from "nocache"


dotenv.config();

const app: Express = express();
app.use(cors());
app.use(nocache())
app.set('etag', false)

const port = process.env.PORT || 8005
const host_name = process.env.HOST_NAME || '127.0.0.1'
const origin = process.env.ORIGIN || 'localhost:3000'
const redisServer = process.env.REDIS_SERVER || 'localhost'
const redisPort = process.env.REDIS_PORT || 6379
const edge_servers = process.env.EDGE_SERVERS || ''
const redis = `redis://${redisServer}:${redisPort}`

const redisSubprocess = spawn(`./run-redis.sh`, [])
redisSubprocess.on('error', (err) => {
  console.error(err)
  process.exit(1)
})
await new Promise<void>((res, rej) => setTimeout(() => res(), 500))
console.log(`[server]: Will connect to redis ${redis}`);

const httpcache = new HTTPCache(origin, redis, `${host_name}:${port}`, edge_servers)
await httpcache.init()

const crdtCache = new CRDTCache(origin, redis)
await crdtCache.init()

app.use('/proxy', proxy(origin, { proxyReqPathResolver: req => req.path.replace('/proxy', '') }))
app.use('/cache', httpcache.middleware)
app.use(express.json())
app.use('/crdt', crdtCache.middleware)
app.use('/invalidate', httpcache.multicast.middleware)

app.get('/', (req, res, next) => {
  res.send("Edge hi")
});

const server = http
    .createServer(app)
    .listen(Number(port), () => {
  console.log(`[server]: Server is running at http://localhost:${port}`);
});

process.stdin.on("data", data => {
  let read_data = data.toString().trim()
  if (read_data.includes("CLOSE")) {
    console.log('CLOSE input received')

    server.closeAllConnections()
    server.close(() => {
      console.log('HTTP server closed')
      process.exit(0)
    })
  }
})

function shutdown() {
  console.log('SIGTERM/SIGINT signal received: closing HTTP server')

  server.closeAllConnections()
  server.close(() => {
    console.log('HTTP server closed')
    process.exit(0)
  })
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
