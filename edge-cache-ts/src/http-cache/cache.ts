import {NextFunction, Request, RequestHandler, Response} from "express";
import proxy from "express-http-proxy"
import {ClientRequest, IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeaders} from "http";
import {createClient, RedisClientType, SetOptions} from 'redis';
import {Multicast} from "../multicast/multicast.js";


class HTTPCache {
    middleware: RequestHandler
    origin: string
    proxy: RequestHandler
    redis: RedisClientType
    redisEvents: RedisClientType
    edge_servers: string[]
    host_name: string
    multicast: Multicast

    constructor(origin: string, redis: string, host_name: string, edge_servers: string) {
        this.middleware = this.routeRequest.bind(this)
        this.origin = origin
        this.proxy = proxy(origin, {
            proxyReqPathResolver: req => req.path.replace('/proxy', ''),
            userResDecorator: this.handleOriginResponse.bind(this),
            userResHeaderDecorator: this.modifyOriginResponsHeades.bind(this),
            parseReqBody: false
        })
        this.redis = createClient({ url: redis })
        this.redisEvents = this.redis.duplicate()
        this.redis.on('error', err => console.log('Redis Client Error', err));
        this.edge_servers = edge_servers.split(',').map(s => s.trim())
        this.host_name = host_name
        this.multicast = new Multicast(this.edge_servers.filter((v,n,a) => { return v != this.host_name }), this.receiveInvalidation.bind(this))
    }

    async init() {
        await this.redis.connect()
        await this.redis.flushAll()
        await this.redisEvents.connect()
        await this.redisEvents.pSubscribe('__key*__:expired', this.receiveExpiryEvent.bind(this))

        if (this.edge_servers.length > 0) {
            this.multicast.start()
        }
    }

    async routeRequest(req: Request, res: Response, next: NextFunction) {
        if (req.method != 'GET') {
            this.proxy(req, res, next)
            return
        }

        let requestKey = req.url

        let redisValue = await this.redis.get(requestKey)
        if (redisValue == null) {
            this.proxy(req, res, next)
        } else {
            const redisObject = JSON.parse(redisValue)

            const headers = redisObject.headers
            for (let i = 0; i < headers.length - 1; i+=2) {
                res.setHeader(headers[i], headers[i+1])
            }
            res.setHeader('X-Cached', "true")
            const r = Buffer.from(redisObject.body, 'base64')
            res.send(r.toString('ascii'))
        }

    }

    async handleOriginResponse(proxyRes: IncomingMessage,
                         proxyResData: any,
                         userReq: Request,
                         userRes: Response): Promise<any> {
        let expirySeconds = 3600
        if (userReq.headers['no-invalidation']) {
            expirySeconds = 300
        }

        if (proxyRes.statusCode == 200) {
            let cc = proxyRes.headers["x-cache-control"]
            if (cc && cc.includes('max-age')) {
                let cacheKey = userReq.url
                const options: SetOptions = { EX: expirySeconds }
                await this.redis.set(cacheKey, JSON.stringify({
                    body: proxyResData.toString('base64'),
                    headers: proxyRes.rawHeaders
                }), options)
                let labels = proxyRes.headersDistinct["x-label"]
                if (labels) {
                    for (const invalidateLabel of labels) {
                        await this.redis.sAdd(invalidateLabel, cacheKey)
                        await this.redis.sAdd(`key:${cacheKey}`, invalidateLabel)
                    }
                }
            }
        }

        if (userReq.headers['no-invalidation']) {
            return proxyResData
        }

        let invlidationHeader = proxyRes.headersDistinct["x-invalidate-cache"]
        if (invlidationHeader) {
            this.multicast.emit(invlidationHeader)
        }

        return proxyResData
    }

    async receiveInvalidation(label: string) {
        const labels = await this.redis.sMembers(label)
        let labels2 = labels.map( (v) => `key:${v}` )
        await this.redis.del(labels.concat(labels2, [label]))
    }

    async receiveExpiryEvent(key: any, channel: any) {
        console.log(`Key Expiring: ${key} on ${channel}`)
        let lookupKey = `key:${key}`
        let deleteLabels = await this.redis.sMembers(lookupKey)
        if (deleteLabels.length > 0) {
            deleteLabels.push(lookupKey)
            await this.redis.del(deleteLabels)
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
        return headers
    }
}

export {HTTPCache}