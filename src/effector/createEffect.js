//@flow

import type {Event, Effect} from './unit.h'
import {step, own, bind, getGraph} from './stdlib'
import {createNode} from './createNode'
import {launch} from './kernel'
import {createNamedEvent, createStore, createEvent} from './createUnit'
import type {EffectConfigPart, Config} from './config'
import {createDefer} from './defer'

declare export function createEffect<Payload, Done>(
  name?: string | EffectConfigPart<Payload, Done>,
  config?: Config<EffectConfigPart<Payload, Done>>,
): Effect<Payload, Done, *>
export function createEffect<Payload, Done>(
  nameOrConfig: any,
  maybeConfig: any,
): Effect<Payload, Done, *> {
  //$off
  const instance: Effect<Payload, Done, any> = createEvent(
    nameOrConfig,
    maybeConfig,
  )
  let handler =
    instance.defaultConfig.handler ||
    (value => {
      console.error(`no handler used in ${instance.getType()}`)
      return Promise.resolve()
    })

  getGraph(instance).meta.onCopy = ['runner']
  getGraph(instance).meta.unit = 'effect'
  const done: Event<{|
    params: Payload,
    result: Done,
  |}> = createNamedEvent('done')
  const fail: Event<{|
    params: Payload,
    error: *,
  |}> = createNamedEvent('fail')
  const anyway: Event<
    | {|
        +status: 'done',
        +params: Payload,
        +result: Done,
      |}
    | {|
        +status: 'fail',
        +params: Payload,
        +error: *,
      |},
  > = createNamedEvent('finally')

  instance.done = done
  instance.fail = fail
  instance.finally = anyway
  instance.use = fn => {
    handler = fn
    return instance
  }
  const getCurrent = () => handler
  instance.use.getCurrent = getCurrent
  instance.kind = 'effect'
  const effectRunner = createNode({
    scope: {
      done,
      fail,
      anyway,
      getHandler: getCurrent,
    },
    node: [
      step.run({
        fn({params, req}, {getHandler, done, fail, anyway}) {
          runEffect(
            getHandler(),
            params,
            bind(onSettled, {
              event: done,
              anyway,
              params,
              fn: req.rs,
              ok: true,
            }),
            bind(onSettled, {
              event: fail,
              anyway,
              params,
              fn: req.rj,
              ok: false,
            }),
          )
          return params
        },
      }),
    ],
    meta: {op: 'fx', fx: 'runner', onCopy: ['done', 'fail', 'anyway']},
  })
  getGraph(instance).scope.runner = effectRunner
  getGraph(instance).seq.push(
    step.compute({
      fn(params, scope, stack) {
        // empty stack means that this node was launched directly
        if (!stack.parent) return params
        return {
          params,
          req: {
            rs(data) {},
            rj(data) {},
          },
        }
      },
    }),
    step.run({
      fn(upd, {runner}) {
        launch({
          target: runner,
          params: upd,
          defer: true,
        })
        return upd.params
      },
    }),
  )
  instance.create = (params: Payload) => {
    const req = createDefer()
    launch(instance, {params, req})
    return req.req
  }

  const inFlight = createStore(0, {named: 'inFlight'})
    .on(instance, x => x + 1)
    .on(done, x => x - 1)
    .on(fail, x => x - 1)

  const pending = inFlight.map({
    fn: amount => amount > 0,
    named: 'pending',
  })
  instance.inFlight = inFlight
  instance.pending = pending

  own(instance, [done, fail, anyway, pending, inFlight, effectRunner])
  return instance
}
const onSettled = ({event, anyway, params, fn, ok}, data) => {
  launch({
    target: [anyway, event, sidechain],
    params: ok
      ? [
        {
          status: 'done',
          params,
          result: data,
        },
        {
          params,
          result: data,
        },
        {
          fn,
          value: data,
        },
      ]
      : [
        {
          status: 'fail',
          params,
          error: data,
        },
        {
          params,
          error: data,
        },
        {
          fn,
          value: data,
        },
      ],
    defer: true,
  })
}
const sidechain = createNode({
  node: [
    step.run({
      fn({fn, value}) {
        fn(value)
      },
    }),
  ],
  meta: {op: 'fx', fx: 'sidechain'},
})

function runEffect(handler, params, onResolve, onReject) {
  let failedSync = false
  let syncError
  let rawResult
  try {
    rawResult = handler(params)
  } catch (err) {
    failedSync = true
    syncError = err
  }
  if (failedSync) {
    onReject(syncError)
    return
  }
  if (Object(rawResult) === rawResult && typeof rawResult.then === 'function') {
    rawResult.then(onResolve, onReject)
    return
  }
  onResolve(rawResult)
}
