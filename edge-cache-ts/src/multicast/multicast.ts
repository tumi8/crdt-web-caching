import {NextFunction, Request, RequestHandler, Response} from "express";


export class Multicast {
    peers: string[]
    sendPipe: [string, number, string[]][]
    middleware: RequestHandler
    callback: (x: string) => void
    immediateRunning: boolean


    constructor(peers: string[], callback: (x: string) => void) {
         this.peers = peers
        for (const peer of this.peers) {
            new URL(`http://${peer}/invalidate`);
        }

        this.sendPipe = []
        this.middleware = this.routeRequest.bind(this)
        this.callback = callback
        this.immediateRunning = false
    }

    start() {
        setInterval(this.sendJob.bind(this), 5000)
    }

    sendJob() {
        this.immediateRunning = true
        const sendFailures = this.sendPipe
        this.sendPipe = []
        const remoteSends = new Map<string, [string, number, string[]]>()
        for (const [peer, retries, labels] of sendFailures) {
            const map_key = `${retries}_${peer}`
            if (!remoteSends.has(map_key)) {
                remoteSends.set(map_key, [peer, retries, []])
            }
            remoteSends.get(map_key)[2].push(...labels)
        }
        for (const [key, [peer, retries, labels ]] of remoteSends.entries()) {
            this.sendToPeer(peer, labels, retries-1)
        }
        this.immediateRunning = false
    }

    async routeRequest(req: Request, res: Response, next: NextFunction) {
        let body = req.body
        if (body.labels) {
            for (const label of body.labels) {
                this.callback(label)
            }
            res.sendStatus(200)
        } else {
            res.sendStatus(500)
        }
    }

    emit(labels: string[]) {
        for (const label of labels) {
            this.callback(label)
        }
        for (const peer of this.peers) {
            this.sendPipe.push([peer, 3, labels])
        }
        if (!this.immediateRunning) {
            this.immediateRunning = true
            setImmediate(this.sendJob.bind(this))
        }
    }

    sendToPeer(peer: string, labels: string[], retries: number) {
        let peerURL = `http://${peer}/invalidate`
        const responsePromise = fetch(peerURL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            cache: 'no-cache',
            body: JSON.stringify({
                labels: labels
            })
        }).catch(reason => {
            if (retries > 0) {
                console.error(`Could not forward invalidations ${labels} to peer ${peer}, via ${peerURL}: ${reason}. Retries lef ${retries}`)
                this.sendPipe.push([peer, retries, labels])
            } else {
                console.error(`Could not forward invalidations ${labels} to peer ${peer}, via ${peerURL}: ${reason}. No retries, stop forward.`)
            }
        })
    }

}
