import {NextFunction, Request, Response, Router} from "express";
import {DocHandle, DocHandleChangePayload, Repo } from "@automerge/automerge-repo";
import {next as A} from "@automerge/automerge"
import microtime from 'microtime';
import * as os from "os";
import {throttle} from "../helper/throttle.js";

class ForumObject {
  constructor(readonly id: number, readonly title: string) {}
}

class MetaObject {
  constructor(public id: string, public version: A.Counter, public forumId: number | null ) {}
}

class ForumDocObject {
  constructor(public data: {[k: string]: ForumObject}, public meta: MetaObject ) {}
}

class ForumDocDetailObject {
  constructor(public data: ForumMessage[], public meta: MetaObject ) {}
}

class ForumMessage {
  constructor(readonly message: string) {}
}

class Forum {

  router: Router
  forums: Map<number, ForumObject>
  forumVersion: number
  forumDetailVersion: Map<number,number>
  forumDetails: Map<number, ForumMessage[]>

  forumDoc: DocHandle<ForumDocObject>
  forumDetailDocs: Map<number, DocHandle<ForumDocDetailObject>>

  repo: Repo

  constructor(repo: Repo) {
    this.repo = repo
    this.router = Router();
    this.forumVersion = 0
    this.forumDetailVersion = new Map()
    this.forums = new Map<number, ForumObject>();
    this.forumDetails = new Map<number, ForumMessage[]>();
    this.forumDetailDocs = new Map();

    for (let j = 0; j < 100; j++) {

      let details = this.initializeForum(j)
      let forumDetail = this.repo.create(new ForumDocDetailObject(
        details,
        { id: `forum_${j}`, version: new A.Counter(0), forumId: j }
      ))
      forumDetail.on('change', this.forumChanged.bind(this))
      forumDetail.on('change', throttle(this.forumChangedThrottled.bind(this), 1000))
      this.forumDetailDocs.set(j, forumDetail)
    }
    this.forumDoc = this.repo.create(new ForumDocObject(
      Object.fromEntries(this.forums.entries()),
      new MetaObject('forums', new A.Counter(this.forumVersion), null)
    ))
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
    let forumDetails = this.forumDetails.get(forumId)
    if (!forumDetails) {
      res.status(404).send({errors: [{title: 'Forum not found'}]})
    } else {
      let forumDetailVersion = this.forumDetailVersion.get(forumId) || 0
      this.forumDetailVersion.set(forumId, forumDetailVersion + 1)
      forumDetails.unshift(message)
      while (forumDetails.length > 100) {
        forumDetails.pop()
      }

      this.logVersion(`forum_${forumId}`, this.forumDetailVersion.get(forumId) || -1)

      res.appendHeader("X-Invalidate-Cache", `forum_${forumId}`)
      res.send({success: true, message: message})
    }
  }

  // Will be called throttled on each forum details separately
  forumChangedThrottled(payload: DocHandleChangePayload<ForumDocDetailObject>) {
    let forumHandle = payload.handle
    forumHandle.change(doc => {
      doc.data.splice(100)
      doc.meta.version.increment(1)
    })
  }

  forumChanged(payload: DocHandleChangePayload<ForumDocDetailObject>) {
    this.logVersion(payload.doc.meta.id, payload.doc.meta.version.value)
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

  initializeForum(forumId: number): ForumMessage[] {
    var title = this.makeRandomString(15)
    let forum =  {
      id: forumId,
      title: title
    }

    this.forums.set(forumId, forum)

    let data: ForumMessage[] = []
    for (let j = 0; j < 100; j++) {
      let message = this.makeRandomString(15)
      data.push({ message: message })
    }
    this.forumDetails.set(forumId, data)
    this.forumDetailVersion.set(forumId, 0)
    this.logVersion(`forum_${forumId}`, 0)
    return data
  }

  private logVersion(s: string, version: number) {
    const log_msg = { type: 'Versioning', time: microtime.now(), object: s, version: version }
    process.stdout.write(JSON.stringify(log_msg) + os.EOL)
  }
}


export default Forum;

