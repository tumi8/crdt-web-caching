import {
    DocHandle, DocHandleChangePayload,
    DocHandleEphemeralMessagePayload,
    isValidAutomergeUrl,
    Repo
} from "@automerge/automerge-repo"
import {NextFunction, Request, RequestHandler, Response} from "express";
import proxy from "express-http-proxy"
import {ClientRequest, IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeaders, RequestOptions} from "http";
import {BrowserWebSocketClientAdapter} from "@automerge/automerge-repo-network-websocket";
import {createClient, RedisClientType, SetOptions} from "redis";


export class CRDTCache {
    middleware: RequestHandler
    origin: string
    repo: Repo
    proxy: RequestHandler
    redis: RedisClientType

    constructor(origin: string, redis: string) {
        this.middleware = this.routeRequest.bind(this)
        this.origin = origin
        this.redis = createClient({ url: redis })
        this.proxy = proxy(origin, {
            proxyReqPathResolver: this.proxyPath,
            userResDecorator: this.handleOriginResponse.bind(this),
            userResHeaderDecorator: this.modifyOriginResponsHeades.bind(this),
            parseReqBody: false
        })

        this.repo = new Repo({
            network: [new BrowserWebSocketClientAdapter(`ws://${origin}`)],
        })
    }

    proxyPath(req: Request) {
        return req.path.replace('/crdt', '').replace("/flights", "/flights/x").replace('/forums', '/forums/x')
    }

    async init() {
        await this.redis.connect()
        await this.redis.flushAll()
    }

    async handleOriginResponse(proxyRes: IncomingMessage,
                               proxyResData: any,
                               userReq: Request,
                               userRes: Response): Promise<any> {

        let h = proxyRes.headers["upgrade"]
        if (proxyRes.statusCode == 200 && h == "crdt") {
            let body = JSON.parse(proxyResData.toString('utf8'))

            if (body.url && isValidAutomergeUrl(body.url)) {
                this.redis.set(`crdt:${userReq.url}`, proxyResData.toString('utf8')).catch(e => console.error(e))

                let handle = this.repo.find(body.url)
                handle.on('ephemeral-message', this.handleDocumentDelete.bind(this))
                // handle.on('change', this.handleDocumentChange.bind(this))

                userRes.setHeader("X-Cached", "false")
                userRes.setHeader("X-CRDT-API", "true")

                let resp = await this.getResponseFromCRDT(userReq, handle, body)
                if (resp.errors) {
                    userRes.status(404)
                }
                return resp
            }
        }

        return proxyResData
    }


    handleDocumentChange(payload: DocHandleChangePayload<unknown>) {
        // this.redis.del(payload.handle.documentId).catch(r => console.error(r))
    }

    handleDocumentDelete(payload: DocHandleEphemeralMessagePayload<any>) {
        if (payload.message == 'delete') {
            // this.redis.del(payload.handle.documentId).catch(r => console.error(r))
            this.repo.delete(payload.handle.documentId)
        }
    }

    async getResponseFromCRDT(req: Request, handle: DocHandle<any>, crdtConfig: any) {
        if (req.method == 'GET') {
            var doc = await handle.doc()
            if (!doc) {
                return { errors: ['Could not find doc']}
            }

            if (crdtConfig.key) {
                if (!doc.data[crdtConfig.key]) {
                    return { errors: [`Could not find ${crdtConfig.key}`]}
                }
                doc = doc.data[crdtConfig.key]
            }

            return doc
        } else if (req.method == 'POST') {
            let jsonBody = await req.body
            if (!handle.isReady()){
                await handle.doc()
            }
            handle.change(doc => {
                doc.data.unshift(jsonBody)
                doc.meta.version.increment(1)
            })
            return { success: true }
        } else {
            throw Error('Unknown HTTP Method')
        }
    }

    async routeRequest(req: Request, res: Response, next: NextFunction) {
        let redisResponse = await this.redis.get(`crdt:${req.url}`)

        if (redisResponse) {
            let crdtConfig = JSON.parse(redisResponse)
            let docHandle = this.repo.find(crdtConfig.url)
            if (docHandle) {
                res.setHeader("X-Cached", "true")
                res.setHeader("X-CRDT-API", "true")
                let responseBody = await this.getResponseFromCRDT(req, docHandle, crdtConfig)
                if (responseBody.errors) {
                    res.status(404)
                } else {
                    res.status(200)
                }
                res.send(responseBody)
            } else {
                res.status(500)
                res.send({errors:['Doc Handle not found']})
            }
        } else {
            this.proxy(req, res, next)
        }
    }

    modifyOriginResponsHeades(
        headers: IncomingHttpHeaders,
        userReq: Request,
        userRes: Response,
        proxyReq: ClientRequest,
        proxyRes: IncomingMessage,
    ): OutgoingHttpHeaders {
        headers['X-Cached'] = "false"
        delete headers['upgrade']
        return headers
    }
}
