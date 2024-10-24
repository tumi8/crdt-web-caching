import express, {NextFunction, Request, Response, Router} from "express";
import {DocHandle, Repo} from "@automerge/automerge-repo";
import {Counter, next as A} from "@automerge/automerge"
import {hrtime} from "node:process"
import microtime from 'microtime';
import * as os from "os";
import {setImmediate} from "timers";


class Flights {

  router: Router
  flights: Map<string, any>
  flightVersion: number
  flightDetailVersion: Map<string,number>
  flightDetails: Map<string, any>

  flightsDoc: DocHandle<object>
  flightDetailsDoc: DocHandle<object>
  repo: Repo

  constructor(repo: Repo) {
    this.repo = repo
    this.router = Router();
    this.flightVersion = 0
    this.flightDetailVersion = new Map()
    this.flights = new Map();
    this.flightDetails = new Map();

    let flightDetails = new Map();
    for (let j = 0; j < 100; j++) {
      let flight = this.generateFlight()
      this.flights.set(flight.number, flight)
      this.initializeFlight(flight.number)
      flightDetails.set(flight.number, this.getCRDTFlight(flight.number))
    }
    this.flightsDoc = this.repo.create({
      data: Object.fromEntries(this.flights.entries()),
      meta:  { id: 'flights', version: new Counter(this.flightVersion) }
    })
    this.flightDetailsDoc = this.repo.create({
      data: Object.fromEntries(flightDetails.entries()),
    })
    this.logVersion('flights', this.flightVersion)
    this.router.get('/x', this.getFlightDocument.bind(this))

    this.router.get('/:flightId/book/:seat', this.bookSeat.bind(this))
    this.router.get('/x/:flightId/book/:seat', this.bookSeat.bind(this))
    this.router.post('/:flightId/book/:seat', this.bookSeat.bind(this))
    this.router.post('/x/:flightId/book/:seat', this.bookSeat.bind(this))

    this.router.get('/', this.getFlights.bind(this))
    this.router.get('/:flightId', this.getFlightDetails.bind(this))
    this.router.get('/x/:flightId', this.getFlightDocDetails.bind(this))
  }

  makeflightId(length: number) {
    let result = '';
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    for (let j = 0; j < length; j++) {
      result += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    return result;
  }

  generateFlight() {
    do {
      var flightNumber = this.makeflightId(5)
    } while (this.flights.has(flightNumber))
    return {
      number: flightNumber
    }
  }

  getFlights(req: Request, res: Response, next: NextFunction) {
    res.setHeader("X-Cache-Control", "max-age=3600")
    res.setHeader("X-Label", `flights`)
    res.send({ data: Object.fromEntries(this.flights.entries()), meta: { id: 'flights', version: this.flightVersion }});
  }

  getFlightDetails(req: Request, res: Response, next: NextFunction) {
    let flightId = req.params.flightId
    if (!this.flights.has(flightId)) {
      res.status(404).send({errors: [{title: "Flight not found"}]})
    } else {
      res.setHeader("X-Cache-Control", "max-age=3600")
      res.setHeader("X-Label", `flight_${flightId}`)

      res.send({ data: this.flightDetails.get(flightId), meta: { id: `flight_${flightId}`, version: this.flightDetailVersion.get(flightId) }});
    }
  }

  bookSeat(req: Request, res: Response, next: NextFunction) {
    let flightId = req.params.flightId
    let seatId: number = Number(req.params.seat)
    if (!this.flights.has(flightId) || seatId < 0 || seatId >= 100) {
      res.status(404).send({errors: [{title: 'Flight/Seat not found'}]})
    } else {
      let flight = this.flightDetails.get(flightId)
      let flightDetailVersion = this.flightDetailVersion.get(flightId) || 0

      if (flight.seatingPlan[seatId].booked) {
        res.status(500).send({success: false, err: "Conflict, seat already booked"})
      } else {
        // Change Flight Details
        // Normal View
        flight.seatingPlan[seatId].booked = true
        flight.seatsLeft--
        flightDetailVersion++
        this.flightDetailVersion.set(flightId, flightDetailVersion)
        // CRDT View

        this.flightDetailsDoc.change( doc => {
          doc.data[flightId].data.seatingPlan[seatId].booked = true
          doc.data[flightId].data.seatsLeft.decrement()
          doc.data[flightId].meta.version.increment()
        })

        res.appendHeader("X-Invalidate-Cache", `flight_${flightId}`)
        this.logVersion(`flight_${flightId}`, flightDetailVersion)

        if (flight.seatsLeft <= 0) {
          // Delete Flight from main list
          this.flights.delete(flightId)
          this.flightVersion++
          // Delete Flight Details
          this.flightDetails.delete(flightId)
          this.flightDetailVersion.delete(flightId)
          // Create New Flight
          let newFlight = this.generateFlight()
          this.initializeFlight(newFlight.number)

          this.flightDetailsDoc.change( doc => {
            delete doc.data[flightId]
            doc.data[newFlight.number] = this.getCRDTFlight(newFlight.number)
          })
          this.logVersion(`flight_${flightId}`, flightDetailVersion + 1)

          this.flights.set(newFlight.number, newFlight)
          this.flightsDoc.change(doc => {
            delete doc.data[flightId]
            doc.data[newFlight.number] = newFlight
            doc.meta.version.increment()
          })
          this.logVersion('flights', this.flightVersion)

          res.appendHeader("X-Invalidate-Cache", `flights`)
        }
        res.send({success: true})
      }
    }
  }

  getFlightDocument(req: Request, res: Response, next: NextFunction) {
    res.setHeader("Upgrade", "crdt")
    res.send({
      url: this.flightsDoc.url
    })
  }

  async getFlightDocDetails(req: Request, res: Response, next: NextFunction) {
    let flightId = req.params.flightId

    res.setHeader("Upgrade", "crdt")
    res.send({
      url: this.flightDetailsDoc.url,
      key: flightId
    })
  }

  private initializeFlight(flightId: string) {
    if (!this.flightDetails.has(flightId)) {
      let details = {
        number: flightId,
        seatingPlan: {},
        seatsLeft: 100,
      }
      for (let j = 0; j < 100; j++) {
        // @ts-ignore
        details.seatingPlan[j] = {
          number: j,
          booked: false
        }
      }
      this.flightDetails.set(flightId, details)
      this.flightDetailVersion.set(flightId, 0)
      this.logVersion(`flight_${flightId}`, 0)
    }
  }

  private getCRDTFlight(flightId: string) {
    let data = {
      number: flightId,
      seatingPlan: {},
      seatsLeft: new Counter(100),
    }
    for (let j = 0; j < 100; j++) {
      // @ts-ignore
      data.seatingPlan[j] = {
        number: j,
        booked: false
      }
    }
    let flight = { data: data, meta: {id: `flight_${flightId}`, version: new Counter(0)} }
    this.logVersion(`flight_${flightId}`, 0)
    return flight
  }

  private logVersion(s: string, flightDetailVersion: number) {
    const log_msg = { type: 'Versioning', time: microtime.now(), object: s, version: flightDetailVersion }
    process.stdout.write(JSON.stringify(log_msg) + os.EOL)
  }
}


export default Flights;

