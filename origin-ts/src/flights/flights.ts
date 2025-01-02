import {NextFunction, Request, Response, Router} from "express";
import {DocHandle, Repo} from "@automerge/automerge-repo";
import {next as A} from "@automerge/automerge"
import microtime from 'microtime';
import * as os from "os";
import {throttle} from "../helper/throttle.js";

class FlightObject {
  constructor(readonly number: string) {}
}

class FlightDetailObject {
  constructor(readonly number: string, public seatingPlan: { [k: number]: { number: number, booked: boolean } }, public seatsLeft: number) {}
}

class MetaObject {
  constructor(public id: string, public version: number ) {}
}

class FlightDocObject {
  constructor(public data: {[k: string]: FlightObject}, public meta: MetaObject ) {}
}

class FlightDocDetailObject {
  constructor(public data: FlightDetailObject, public meta: MetaObject ) {}
}

class FlightsDocDetailObject {
  constructor(public data: {[k: string]: FlightDocDetailObject}) {}
}


class Flights {

  router: Router
  flights: Map<string, FlightObject>
  flightVersion: number

  flightDetails: Map<string, FlightDocDetailObject>

  flightsDoc: DocHandle<FlightDocObject>
  flightDetailsDoc: DocHandle<FlightsDocDetailObject>

  updateFlightsDocThrottled: () => void
  updateFlightDetailsDocThrottled: () => void

  repo: Repo
  currentFlightId: number

  constructor(repo: Repo) {
    this.repo = repo
    this.router = Router();
    this.flightVersion = 0
    this.flights = new Map();
    this.flightDetails = new Map();

    this.currentFlightId = 0

    for (let j = 0; j < 100; j++) {
      let flight = this.createFlight()
      this.flights.set(flight.number, flight)

      this.flightDetails.set(flight.number, this.createFlightDetails(flight.number))
    }
    this.flightsDoc = this.repo.create(new FlightDocObject(
      Object.fromEntries(this.flights.entries()),
      new MetaObject('flights', this.flightVersion)
    ))
    this.flightDetailsDoc = this.repo.create(new FlightsDocDetailObject(
      Object.fromEntries(this.flightDetails.entries())
    ))
    this.logVersion('flights', this.flightVersion)
    this.router.get('/x', this.getFlightDocument.bind(this))

    this.router.get('/:flightId/book/:seat', this.bookSeat.bind(this))
    this.router.get('/x/:flightId/book/:seat', this.bookSeat.bind(this))
    this.router.post('/:flightId/book/:seat', this.bookSeat.bind(this))
    this.router.post('/x/:flightId/book/:seat', this.bookSeat.bind(this))

    this.router.get('/', this.getFlights.bind(this))
    this.router.get('/:flightId', this.getFlightDetails.bind(this))
    this.router.get('/x/:flightId', this.getFlightDocDetails.bind(this))

    this.updateFlightsDocThrottled = throttle(this.updateFlightsDoc.bind(this), 200)
    this.updateFlightDetailsDocThrottled = throttle(this.updateFlightDetailsDoc.bind(this), 400)
  }

  createFlight(): FlightObject {
    let flightId = this.currentFlightId += 1
    return new FlightObject(flightId.toString())
  }

  getFlights(req: Request, res: Response, next: NextFunction) {
    res.setHeader("X-Cache-Control", "max-age=3600")
    res.setHeader("X-Label", `flights`)
    res.send({ data: Object.fromEntries(this.flights.entries()), meta: new MetaObject('flights', this.flightVersion)});
  }

  getFlightDetails(req: Request, res: Response, next: NextFunction) {
    let flightId = req.params.flightId
    if (!this.flights.has(flightId)) {
      res.appendHeader("X-Invalidate-Cache", `flights`)
      res.status(404).send({errors: [{title: "Flight not found"}]})
    } else {
      res.setHeader("X-Cache-Control", "max-age=3600")
      res.setHeader("X-Label", `flight_${flightId}`)
      res.send(this.flightDetails.get(flightId))
    }
  }

  bookSeat(req: Request, res: Response, next: NextFunction) {
    let flightId = req.params.flightId
    let seatId: number = Number(req.params.seat)
    let flight = this.flightDetails.get(flightId)
    if (!this.flights.has(flightId) || seatId < 0 || seatId >= 100 || !flight) {
      res.status(404).send({errors: [{title: 'Flight/Seat not found'}]})
    } else {
      if (flight.data.seatingPlan[seatId].booked) {
        res.appendHeader("X-Invalidate-Cache", `flight_${flightId}`)
        res.status(500).send({success: false, err: "Conflict, seat already booked"})
      } else {
        // Change Flight Details
        // Normal View
        flight.data.seatingPlan[seatId].booked = true
        flight.data.seatsLeft--
        flight.meta.version++

        res.appendHeader("X-Invalidate-Cache", `flight_${flightId}`)
        this.logVersion(`flight_${flightId}`, flight.meta.version)
        this.updateFlightDetailsDocThrottled()

        if (flight.data.seatsLeft <= 0) {
          // Delete Flight from main list
          this.flights.delete(flightId)
          this.flightVersion++
          // Delete Flight Details
          this.flightDetails.delete(flightId)
          this.logVersion(`flight_${flightId}`, flight.meta.version + 1)

          // Create New Flight
          let newFlight = this.createFlight()
          let newFlightDetails = this.createFlightDetails(newFlight.number)

          this.flights.set(newFlight.number, newFlight)
          this.updateFlightsDocThrottled()

          this.flightDetails.set(newFlight.number, newFlightDetails)
          this.updateFlightDetailsDocThrottled()

          this.logVersion('flights', this.flightVersion)

          res.appendHeader("X-Invalidate-Cache", `flights`)
        }
        res.send({success: true})
      }
    }
  }

  updateFlightsDoc() {
    let newFlightData = Object.fromEntries(this.flights.entries())
    let currentFlightVersion = this.flightVersion
    this.flightsDoc.change((doc) => {
      doc.data = newFlightData
      doc.meta.version = currentFlightVersion
    })
  }

  updateFlightDetailsDoc() {
    let source = Object.fromEntries(this.flightDetails.entries())
    let sourceKeys = new Set(Object.keys(source))

    let currentCRDT = this.flightDetailsDoc.docSync()
    if (currentCRDT) {
      let currentKeys = new Set(Object.keys(currentCRDT.data))

      this.flightDetailsDoc.change((doc) => {
        for (const key of currentKeys.difference(sourceKeys)) {
          delete doc.data[key]
        }
        for (const key of sourceKeys) {
          if (key in currentCRDT.data) {
            if (source[key].meta.version != currentCRDT.data[key].meta.version) {
              doc.data[key].meta.version = source[key].meta.version
              doc.data[key].data.seatsLeft = source[key].data.seatsLeft

              for ( const entry of Object.values(source[key].data.seatingPlan)) {
                if (currentCRDT.data[key].data.seatingPlan[entry.number].booked != entry.booked) {
                  doc.data[key].data.seatingPlan[entry.number].booked = entry.booked
                }
              }
            }
          } else {
            doc.data[key] = source[key]
          }
        }
      })
    }
  }

  // bookSeatCRDT(req: Request, res: Response, next: NextFunction) {
  //   let flightId = req.params.flightId
  //   let seatId: number = Number(req.params.seat)
  //   let flightDetails = this.flightDetailsDoc.docSync()
  //   if (!flightDetails || seatId < 0 || seatId >= 100) {
  //     res.status(404).send({errors: [{title: 'Flight/Seat not found'}]})
  //   } else {
  //     let flight = flightDetails.data[flightId]
  //     if (!flight) {
  //       res.status(404).send({errors: [{title: 'Flight not found'}]})
  //       return
  //     }
  //     if (flight.data.seatingPlan[seatId].booked) {
  //       res.status(500).send({success: false, err: "Conflict, seat already booked"})
  //     } else {
  //       // Change Flight Details
  //       this.flightDetailsDoc.change( doc => {
  //         doc.data[flightId].data.seatingPlan[seatId].booked = true
  //         doc.data[flightId].data.seatsLeft.decrement(1)
  //         doc.data[flightId].meta.version.increment(1)
  //       })
  //       this.logVersion(`flight_${flightId}`, flight.meta.version.value + 1)
  //
  //       if (flight.data.seatsLeft.value <= 1) {
  //         // Create New Flight
  //         let newFlight = this.createFlight()
  //         let flightDetails = this.getCRDTFlight(newFlight.number)
  //
  //         this.flightDetailsDoc.change( doc => {
  //           delete doc.data[flightId]
  //           doc.data[newFlight.number] = flightDetails
  //         })
  //         this.logVersion(`flight_${flightId}`,  flight.meta.version.value + 2)
  //
  //         this.flightsDoc.change(doc => {
  //           delete doc.data[flightId]
  //           doc.data[newFlight.number] = newFlight
  //           doc.meta.version.increment(1)
  //         })
  //         this.logVersion('flights', this.flightVersion)
  //       }
  //       res.send({success: true})
  //     }
  //   }
  // }

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

  private createFlightDetails(flightId: string): FlightDocDetailObject {
    let maxSeats = 100
    let details = new FlightDetailObject(flightId, {}, maxSeats)

    for (let j = 0; j < maxSeats; j++) {
      details.seatingPlan[j] = {
        number: j,
        booked: false
      }
    }
    this.logVersion(`flight_${flightId}`, 0)
    return new FlightDocDetailObject(details, new MetaObject(`flight_${flightId}`, 0))
  }

  // private getCRDTFlight(flightId: string): FlightDocDetailObject {
  //   let details = new FlightDetailCRDTObject(flightId, {}, new A.Counter(100))
  //   for (let j = 0; j < 100; j++) {
  //     details.seatingPlan[j] = {
  //       number: j,
  //       booked: false
  //     }
  //   }
  //   let flight = new FlightDocDetailObject(details, new MetaCRDTObject(`flight_${flightId}`, new A.Counter(0)))
  //   this.logVersion(`flight_${flightId}`, 0)
  //   return flight
  // }

  private logVersion(s: string, flightDetailVersion: number) {
    const log_msg = { type: 'Versioning', time: microtime.now(), object: s, version: flightDetailVersion }
    process.stdout.write(JSON.stringify(log_msg) + os.EOL)
  }
}


export default Flights;

