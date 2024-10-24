import express, {NextFunction, Request, Response, Router} from "express";
import {DocHandle, Repo} from "@automerge/automerge-repo";
import {Counter, next as A} from "@automerge/automerge"
import {hrtime} from "node:process"
import microtime from 'microtime';
import * as os from "os";
import {DocHandleChangePayload} from "@automerge/automerge-repo/src/DocHandle.js";
import {throttle} from "@automerge/automerge-repo/src/helpers/throttle.js";


class Forum {

  router: Router
  forums: Map<number, any>
  forumVersion: number
  forumDetailVersion: Map<number,number>
  forumDetails: Map<number, any>

  forumDoc: DocHandle<object>
  forumDetailDocs: Map<number, DocHandle<object>>

  repo: Repo

  constructor(repo: Repo) {
    this.repo = repo
    this.router = Router();
    this.forumVersion = 0
    this.forumDetailVersion = new Map()
    this.forums = new Map();
    this.forumDetails = new Map();
    this.forumDetailDocs = new Map();

    for (let j = 0; j < 100; j++) {
      let forum = this.generateForum(j)
      this.forums.set(j, forum)
      this.initializeForum(j)
      let forumDetail = this.repo.create({
        data: this.forumDetails.get(j),
        meta: { id: `forum_${j}`, version: new Counter(0), forumId: j }
      })
      forumDetail.on('change', this.logForumChange.bind(this))
      forumDetail.on('change', throttle(this.forumChanged.bind(this), 100))
      this.forumDetailDocs.set(j, forumDetail)
    }
    this.forumDoc = this.repo.create({
      data: Object.fromEntries(this.forums.entries()),
      meta:  { id: 'forums', version: new Counter(this.forumVersion) }
    })
    this.logVersion('forum', this.forumVersion)

    this.router.get('/', this.getForums.bind(this))
    this.router.get('/x', this.getForumDocument.bind(this))

    this.router.get('/:forumId', this.getForumDetails.bind(this))
    this.router.post('/:forumId', this.postMessage.bind(this))

    this.router.get('/x/:forumId', this.getForumDocDetails.bind(this))
    this.router.post('/x/:forumId', this.getForumDocDetails.bind(this))
  }

  makeRandomString(length: number) {
    let result = '';
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    for (let j = 0; j < length; j++) {
      result += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    return result;
  }

  generateForum(id: number) {
    var title = this.makeRandomString(15)
    return {
      id: id,
      title: title
    }
  }

  getForums(req: Request, res: Response, next: NextFunction) {
    res.setHeader("X-Cache-Control", "max-age=3600")
    res.setHeader("X-Label", `forums`)
    res.send({ data: Array.from(this.forums.values()), meta: { id: 'forums', version: this.forumVersion }});
  }

  getForumDetails(req: Request, res: Response, next: NextFunction) {
    let forumId = Number(req.params.forumId)
    if (!this.forums.has(forumId)) {
      res.status(404).send({errors: [{title: "Forum not found"}]})
    } else {
      res.setHeader("X-Cache-Control", "max-age=3600")
      res.setHeader("X-Label", `forum_${forumId}`)

      res.send({ data: this.forumDetails.get(forumId), meta: { id: `forum_${forumId}`, version: this.forumDetailVersion.get(forumId) }});
    }
  }

  postMessage(req: Request, res: Response, next: NextFunction) {
    let forumId = Number(req.params.forumId)
    let message = req.body
    if (!this.forums.has(forumId)) {
      res.status(404).send({errors: [{title: 'Forum not found'}]})
    } else {
      let forum = this.forumDetails.get(forumId)
      let forumDetailVersion = this.forumDetailVersion.get(forumId) || 0
      this.forumDetailVersion.set(forumId, forumDetailVersion + 1)
      forum.unshift(message)
      if (forum.length > 100) {
        forum.pop()
      }
      this.forumDetailDocs.get(forumId)?.change(doc => {
        doc.data.unshift(message)
        doc.meta.version.increment()
      })

      this.logVersion(`forum_${forumId}`, this.forumDetailVersion.get(forumId) || -1)

      res.appendHeader("X-Invalidate-Cache", `forum_${forumId}`)
      res.send({success: true, message: message})
    }
  }

  forumChanged(payload: DocHandleChangePayload<object>) {
    let forumId = payload.doc.meta.forumId
    if (payload.doc.data != this.forumDetails.get(forumId)) {
      this.forumDetails.set(forumId, payload.doc.data)
      this.forumDetailVersion.set(forumId, payload.doc.meta.version.value)
    }
    if (payload.doc.data.length > 100) {
      payload.handle.change(doc => {
        doc.data.splice(100)
        doc.meta.version.increment(1)
      })
    }
  }

  logForumChange(payload: DocHandleChangePayload<object>) {
    this.logVersion(payload.doc.meta.id, payload.doc.meta.version)
  }

  getForumDocument(req: Request, res: Response, next: NextFunction) {
    res.setHeader("Upgrade", "crdt")
    res.send({
      url: this.forumDoc.url
    })
  }

  getForumDocDetails(req: Request, res: Response, next: NextFunction) {
    let forumId = Number(req.params.forumId)
    let docHandle = this.forumDetailDocs.get(forumId)
    if (!docHandle) {
      res.status(404).send({errors: ['Forum not found']})
      return
    }
    res.setHeader("Upgrade", "crdt")
    res.send({
      url: docHandle.url
    })
  }

  private initializeForum(forumId: number) {
    if (!this.forumDetails.has(forumId)) {
      let data = []
      for (let j = 0; j < 100; j++) {
        let message = this.makeRandomString(15)
        data.push({ message: message })
      }
      this.forumDetails.set(forumId, data)
      this.forumDetailVersion.set(forumId, 0)
      this.logVersion(`forum_${forumId}`, 0)
    }
  }

  private logVersion(s: string, version: number) {
    const log_msg = { type: 'Versioning', time: microtime.now(), object: s, version: version }
    process.stdout.write(JSON.stringify(log_msg) + os.EOL)
  }
}


export default Forum;

