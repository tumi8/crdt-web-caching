#!/usr/bin/env tsx

import express, { Express, Request, Response } from "express";
import http from 'http';
import dotenv from "dotenv";
import { WebSocketServer } from "ws"
import { NodeWSServerAdapter } from '@automerge/automerge-repo-network-websocket'
import { Repo, RepoConfig } from "@automerge/automerge-repo"
import Flights from "./flights/flights.js";
import cors from 'cors';
import nocache from "nocache"
import bodyParser from 'body-parser'
import Forum from "./forum/forum.js";


dotenv.config();

const app: Express = express()
app.use(cors())
app.use(bodyParser.json())
app.use(nocache())
app.set('etag', false)
const port = process.env.PORT || 3000;

const wsServer = new WebSocketServer({ noServer: true })
const config: RepoConfig = {
  network: [new NodeWSServerAdapter(wsServer)],
  // storage: new NodeFSStorageAdapter(),
}
const serverRepo = new Repo(config)
serverRepo.saveDebounceRate = 200

const flights = new Flights(serverRepo)
const forums = new Forum(serverRepo)

app.get('/', (req, res, next) => {
  res.send("hi")
});
app.use('/flights', flights.router);
app.use('/forums', forums.router);

const server = http
    .createServer(app)
    .listen(port, () => {
  console.log(`[server]: Server is running at http://localhost:${port}`);
});

// @ts-ignore
server.on("upgrade", (request, socket, head) => {
  wsServer.handleUpgrade(request, socket, head, (socket) => {
    wsServer.emit("connection", socket, request)
  })
})

process.stdin.on("data", data => {
  let read_data = data.toString().trim()
  if (read_data.includes("CLOSE")) {
    console.log('CLOSE input received')

    wsServer.close(() => {
      console.log('Websocket server closed')
    })
    server.closeAllConnections()
    server.close(() => {
      console.log('HTTP server closed')
    })
  }
})

function shutdown() {
  console.log('SIGTERM/SIGINT signal received: closing HTTP server')
  wsServer.close(() => {
    console.log('Websocket server closed')
  })
  server.closeAllConnections()
  server.close(() => {
    console.log('HTTP server closed')
    //process.exit(0)
  })
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
