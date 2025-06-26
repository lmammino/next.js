import fs from 'fs-extra'
import {
  chromium,
  webkit,
  firefox,
  Browser,
  BrowserContext,
  Page,
  ElementHandle,
  devices,
  Locator,
  Request as PlaywrightRequest,
  Response as PlaywrightResponse,
} from 'playwright'
import path from 'path'
import { TestingLogger } from 'next-test-utils'

type EventType = 'request' | 'response'

type PageLog = { source: string; message: string; args: unknown[] }

const tracePlaywright = process.env.TRACE_PLAYWRIGHT

const defaultTimeout = process.env.NEXT_E2E_TEST_TIMEOUT
  ? parseInt(process.env.NEXT_E2E_TEST_TIMEOUT, 10)
  : // In development mode, compilation can take longer due to lower CPU
    // availability in GitHub Actions.
    60 * 1000

function launchBrowser(
  browserName: string,
  launchOptions: Record<string, any>
) {
  if (browserName === 'safari') {
    return webkit.launch(launchOptions)
  } else if (browserName === 'firefox') {
    return firefox.launch({
      ...launchOptions,
      firefoxUserPrefs: {
        ...launchOptions.firefoxUserPrefs,
        // The "fission.webContentIsolationStrategy" pref must be
        // set to 1 on Firefox due to the bug where a new history
        // state is pushed on a page reload.
        // See https://github.com/microsoft/playwright/issues/22640
        // See https://bugzilla.mozilla.org/show_bug.cgi?id=1832341
        'fission.webContentIsolationStrategy': 1,
      },
    })
  } else {
    return chromium.launch({
      devtools: !launchOptions.headless,
      ...launchOptions,
      ignoreDefaultArgs: ['--disable-back-forward-cache'],
    })
  }
}

interface ElementHandleExt extends ElementHandle {
  getComputedCss(prop: string): Promise<string>
  text(): Promise<string>
}

type WebSocketFrame = { payload: string | Buffer }

const logger = new TestingLogger('playwright')

export class PlaywrightManager {
  private context: BrowserContext
  private activeTrace?: string

  private async initContextTracing(url: string, context: BrowserContext) {
    // If tracing is disabled or a trace is already active, do nothing.
    if (!tracePlaywright || this.activeTrace) return

    try {
      await context.tracing.start({
        screenshots: true,
        snapshots: true,
        sources: true,
      })
      this.activeTrace = encodeURIComponent(url)
    } catch (e) {
      this.activeTrace = undefined
    }
  }

  private async teardownTracing() {
    // If no trace is active, do nothing.
    if (!this.activeTrace) return

    try {
      const traceDir = path.join(__dirname, '../../traces')
      const traceOutputPath = path.join(
        traceDir,
        `${path
          .relative(path.join(__dirname, '../../'), process.env.TEST_FILE_PATH!)
          .replace(/\//g, '-')}`,
        `playwright-${this.activeTrace}-${Date.now()}.zip`
      )

      await fs.remove(traceOutputPath)
      await this.context.tracing.stop({
        path: traceOutputPath,
      })
    } catch (e) {
      logger.warn('Failed to teardown playwright tracing', e)
    } finally {
      this.activeTrace = undefined
    }
  }

  private static shared?: Browser | undefined
  static async setup(
    browserName: string,
    locale: string,
    javaScriptEnabled: boolean,
    ignoreHTTPSErrors: boolean,
    headless: boolean,
    userAgent: string | undefined
  ) {
    let device
    if (process.env.DEVICE_NAME) {
      device = devices[process.env.DEVICE_NAME]

      if (!device) {
        throw new Error(
          `Invalid playwright device name ${process.env.DEVICE_NAME}`
        )
      }
    }

    // Create a browser instance if it doesn't exist using the singleton
    // pattern.
    const browser = (this.shared ??= await launchBrowser(browserName, {
      headless,
    }))

    const context = await browser.newContext({
      locale,
      javaScriptEnabled,
      ignoreHTTPSErrors,
      ...(userAgent ? { userAgent } : {}),
      ...device,
    })

    return new PlaywrightManager(context)
  }

  private constructor(context: BrowserContext) {
    this.context = context
  }

  async closeContext(): Promise<void> {
    try {
      await this.teardownTracing()
      await this.context.close()
    } catch (err) {
      console.error('Failed to close context', err)
    }
  }

  async close() {
    try {
      await PlaywrightManager.shared?.close()
    } catch (err) {
      console.error('Failed to close browser', err)
    } finally {
      PlaywrightManager.shared = undefined
    }
  }

  async newPage(
    url: string,
    opts?: {
      disableCache?: boolean
      cpuThrottleRate?: number
      pushErrorAsConsoleLog?: boolean
      beforePageLoad?: (page: Page) => void
    }
  ) {
    const page = await this.context.newPage()

    if (opts?.disableCache) {
      // TODO: this doesn't seem to work (dev tools does not check the box as expected)
      const session = await this.context.newCDPSession(page)
      session.send('Network.setCacheDisabled', { cacheDisabled: true })
    }

    if (opts?.cpuThrottleRate) {
      const session = await this.context.newCDPSession(page)
      // https://chromedevtools.github.io/devtools-protocol/tot/Emulation/#method-setCPUThrottlingRate
      session.send('Emulation.setCPUThrottlingRate', {
        rate: opts.cpuThrottleRate,
      })
    }

    await this.initContextTracing(url, this.context)
    const browser = new Playwright(page, opts)

    opts?.beforePageLoad?.(page)
    await browser.goto(url, { waitUntil: 'load' })

    return browser
  }
}

export class Playwright<TCurrent = void> {
  private readonly page: Page

  constructor(
    page: Page,
    opts: { pushErrorAsConsoleLog?: boolean } | undefined
  ) {
    this.page = page

    page.setDefaultTimeout(defaultTimeout)
    page.setDefaultNavigationTimeout(defaultTimeout)

    page.on('console', (msg) => {
      console.log('browser log:', msg)

      this._logs.push(
        Promise.all(
          msg.args().map((handle) => handle.jsonValue().catch(() => {}))
        ).then((args) => ({ source: msg.type(), message: msg.text(), args }))
      )
    })
    page.on('crash', () => {
      console.error('page crashed')
    })
    page.on('pageerror', (error) => {
      console.error('page error', error)

      if (opts?.pushErrorAsConsoleLog) {
        this._logs.push({
          source: 'error',
          message: error.message,
          args: [],
        })
      }
    })
    page.on('request', (req) => {
      this.eventCallbacks.request.forEach((cb) => cb(req))
    })
    page.on('response', (res) => {
      this.eventCallbacks.response.forEach((cb) => cb(res))
    })

    page.on('websocket', (ws) => {
      if (tracePlaywright) {
        page
          .evaluate(`console.log('connected to ws at ${ws.url()}')`)
          .catch(() => {})

        ws.on('close', () =>
          page
            .evaluate(`console.log('closed websocket ${ws.url()}')`)
            .catch(() => {})
        )
      }
      ws.on('framereceived', (frame) => {
        this._websocketFrames.push({ payload: frame.payload })

        if (tracePlaywright) {
          page
            .evaluate(`console.log('received ws message ${frame.payload}')`)
            .catch(() => {})
        }
      })
    })
  }

  private readonly eventCallbacks: Record<
    EventType,
    Set<(...args: any[]) => void>
  > = {
    request: new Set(),
    response: new Set(),
  }
  on(
    event: 'request',
    cb: (request: PlaywrightRequest) => void | Promise<void>
  ): void
  on(
    event: 'response',
    cb: (request: PlaywrightResponse) => void | Promise<void>
  ): void
  on(event: EventType, cb: (...args: any[]) => void) {
    if (!this.eventCallbacks[event]) {
      throw new Error(
        `Invalid event passed to browser.on, received ${event}. Valid events are ${Object.keys(
          this.eventCallbacks
        )}`
      )
    }
    this.eventCallbacks[event]?.add(cb)
  }

  off(
    event: 'request',
    cb: (request: PlaywrightRequest) => void | Promise<void>
  ): void
  off(
    event: 'response',
    cb: (request: PlaywrightResponse) => void | Promise<void>
  ): void
  off(event: EventType, cb: (...args: any[]) => void) {
    this.eventCallbacks[event]?.delete(cb)
  }

  goto(
    url: string,
    options?: {
      referer?: string
      timeout?: number
      waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit'
    }
  ) {
    return this.page.goto(url, options)
  }

  back(options?: Parameters<Page['goBack']>[0]) {
    // do not preserve the previous chained value, it might be invalid after a navigation.
    return this.startChain(async () => {
      await this.page.goBack(options)
    })
  }

  forward(options?: Parameters<Page['goForward']>[0]) {
    // do not preserve the previous chained value, it might be invalid after a navigation.
    return this.startChain(async () => {
      await this.page.goForward(options)
    })
  }

  refresh() {
    // do not preserve the previous chained value, it's likely to be invalid after a reload.
    return this.startChain(async () => {
      await this.page.reload()
    })
  }
  setDimensions({ width, height }: { height: number; width: number }) {
    return this.startOrPreserveChain(async () => {
      await this.page.setViewportSize({ width, height })
    })
  }
  addCookie(opts: { name: string; value: string }) {
    return this.startOrPreserveChain(async () =>
      this.page.context().addCookies([
        {
          path: '/',
          domain: await this.page?.evaluate('window.location.hostname'),
          ...opts,
        },
      ])
    )
  }
  deleteCookies() {
    return this.startOrPreserveChain(async () =>
      this.page.context().clearCookies()
    )
  }

  private wrapElement(el: ElementHandle, selector: string): ElementHandleExt {
    const getComputedCss = (prop: string) => {
      return (
        this.page.evaluate(
          function (args) {
            const style = getComputedStyle(
              document.querySelector(args.selector)!
            )
            return style[args.prop] || null
          },
          { selector, prop }
        ) ?? Promise.resolve(null)
      )
    }

    return Object.assign(el, {
      selector,
      getComputedCss,
      text: () => el.innerText(),
    })
  }

  elementByCss(selector: string) {
    return this.waitForElementByCss(selector, 5_000)
  }

  elementById(id: string) {
    return this.elementByCss(`#${id}`)
  }

  getValue(this: Playwright<ElementHandleExt>) {
    return this.continueChain((el) => el.inputValue())
  }

  text(this: Playwright<ElementHandleExt>) {
    return this.continueChain((el) => el.innerText())
  }

  type(this: Playwright<ElementHandleExt>, text: string) {
    return this.continueChain(async (el) => {
      await el.type(text)
      return el
    })
  }

  moveTo(this: Playwright<ElementHandleExt>) {
    return this.continueChain(async (el) => {
      await el.hover()
      return el
    })
  }

  async getComputedCss(this: Playwright<ElementHandleExt>, prop: string) {
    return this.continueChain((el) => el.getComputedCss(prop))
  }

  async getAttribute(this: Playwright<ElementHandleExt>, attr: string) {
    return this.continueChain((el) => el.getAttribute(attr))
  }

  hasElementByCssSelector(selector: string) {
    return this.eval<boolean>(`!!document.querySelector('${selector}')`)
  }

  keydown(key: string) {
    return this.startOrPreserveChain(
      () => this.page?.keyboard.down(key) ?? Promise.resolve()
    )
  }

  keyup(key: string) {
    return this.startOrPreserveChain(
      () => this.page?.keyboard.up(key) ?? Promise.resolve()
    )
  }

  click(this: Playwright<ElementHandleExt>) {
    return this.continueChain(async (el) => {
      await el.click()
      return el
    })
  }

  touchStart(this: Playwright<ElementHandleExt>) {
    return this.continueChain(async (el) => {
      await el.dispatchEvent('touchstart')
      return el
    })
  }

  elementsByCss(selector: string) {
    return this.startChain(async () => {
      const els = await this.page.$$(selector)
      return els.map((el) => {
        const origGetAttribute = el.getAttribute.bind(el)
        el.getAttribute = (name) => {
          // ensure getAttribute defaults to empty string to
          // match selenium
          return origGetAttribute(name).then((val) => val || '')
        }
        return el
      })
    })
  }

  waitForElementByCss(selector: string, timeout = 10_000) {
    return this.startChain(async () => {
      const el = await this.page.waitForSelector(selector, {
        timeout,
        state: 'attached',
      })
      // it seems selenium waits longer and tests rely on this behavior
      // so we wait for the load event fire before returning
      await this.page.waitForLoadState()
      return this.wrapElement(el!, selector)
    })
  }

  waitForCondition(snippet: string, timeout?: number) {
    return this.startOrPreserveChain(async () => {
      await this.page.waitForFunction(snippet, { timeout })
    })
  }

  // TODO: this should default to unknown, but a lot of tests use and rely on the result being `any`
  eval<TFn extends (...args: any[]) => any>(
    fn: TFn,
    ...args: Parameters<TFn>
  ): Playwright<ReturnType<TFn>> & Promise<ReturnType<TFn>>
  // TODO: this is ugly, the type parameter is basically a hidden cast
  eval<T = any>(fn: string, ...args: any[]): Playwright<T> & Promise<T>
  eval<T = any>(
    fn: string | ((...args: any[]) => any),
    ...args: any[]
  ): Playwright<T> & Promise<T>
  eval(
    fn: string | ((...args: any[]) => any),
    ...args: any[]
  ): Playwright<any> & Promise<any> {
    return this.startChain(async () => {
      return this.page
        .evaluate(fn, ...args)
        .catch((err) => {
          // TODO: gross, why are we doing this
          console.error('eval error:', err)
          return null!
        })
        .finally(async () => {
          await this.page?.waitForLoadState()
        })
    })
  }

  private readonly _logs: Array<Promise<PageLog> | PageLog> = []
  async logs<T extends boolean = false>(options?: { includeArgs?: T }) {
    return this.startChain(
      () =>
        options?.includeArgs
          ? Promise.all(this._logs)
          : Promise.all(this._logs).then((logs) =>
              logs.map(({ source, message }) => ({ source, message }))
            )
      // TODO: Starting with TypeScript 5.8 we might not need this type cast.
    ) as Promise<
      T extends true
        ? { source: string; message: string; args: unknown[] }[]
        : { source: string; message: string }[]
    >
  }

  private readonly _websocketFrames: Array<WebSocketFrame> = []
  async websocketFrames(): Promise<ReadonlyArray<WebSocketFrame>> {
    return this.startChain(() => this._websocketFrames)
  }

  async url() {
    return this.startChain(() => {
      return this.page.url()
    })
  }

  async waitForIdleNetwork() {
    return this.startOrPreserveChain(() => {
      return this.page.waitForLoadState('networkidle')
    })
  }

  locateRedbox(): Locator {
    if (!this.page) {
      throw new Error('No page is loaded')
    }
    return this.page.locator(
      'nextjs-portal [aria-labelledby="nextjs__container_errors_label"]'
    )
  }

  locateDevToolsIndicator(): Locator {
    if (!this.page) {
      throw new Error('No page is loaded')
    }
    return this.page.locator('nextjs-portal [data-nextjs-dev-tools-button]')
  }

  /** A call that expects to be chained after a previous call, because it needs its value. */
  private continueChain<TNext>(nextCall: (value: TCurrent) => Promise<TNext>) {
    return this._chain(true, nextCall)
  }

  /** Start a chain. If continuing, it overwrites the current chained value. */
  private startChain<TNext>(nextCall: () => TNext | Promise<TNext>) {
    return this._chain(false, nextCall)
  }

  /** Either start or continue a chain. If continuing, it preserves the current chained value. */
  private startOrPreserveChain(nextCall: () => Promise<void>) {
    return this._chain(false, async (value) => {
      await nextCall()
      return value
    })
  }

  // necessary for the type of the function below
  readonly [Symbol.toStringTag]: string = 'Playwright'

  private _chain<TNext>(
    this: Playwright<TCurrent>,
    mustBeChained: boolean,
    nextCall: (current: TCurrent) => TNext | Promise<TNext>
  ): Playwright<TNext> & Promise<TNext> {
    const syncError = new Error('next-browser-base-chain-error')

    // If `this` is actually a proxy created by a previous chained call, it'll act like it has a `promise` property.
    // (see proxy code below)
    type MaybeChained<T> = Playwright<T> & {
      promise?: Promise<T>
    }
    const self = this as MaybeChained<TCurrent>

    let currentPromise = self.promise
    if (!currentPromise) {
      if (mustBeChained) {
        // Note that this should also be enforced by the type system
        // by adding appropriate `(this: Playwright<PreviousValue>)` type annotations
        // to methods that expect to be chained, but tests can bypass this (or not be checked because they use JS)
        throw new Error(
          'Expected this call to be chained after a previous call'
        )
      } else {
        // We're handling a call that does not expect to be chained after a previous one,
        // so it's safe to default the current value to undefined -- we don't need a value to invoke `nextCall`
        currentPromise = Promise.resolve(undefined as TCurrent)
      }
    }

    const promise = currentPromise.then(nextCall).catch((reason: unknown) => {
      // TODO: only patch the stacktrace if the sync callstack is missing from it
      if (reason && typeof reason === 'object' && 'stack' in reason) {
        const syncCallStack = syncError.stack!.split(syncError.message)[1]
        reason.stack += `\n${syncCallStack}`
      }
      throw reason
    })

    function get(target: Playwright<TCurrent>, p: string | symbol): any {
      switch (p) {
        case 'promise':
          return promise
        case 'then':
          return promise.then.bind(promise)
        case 'catch':
          return promise.catch.bind(promise)
        case 'finally':
          return promise.finally.bind(promise)
        default:
          return target[p]
      }
    }

    // @ts-expect-error: we're changing `TCurrent` into TNext via proxy hacks
    return new Proxy(this, {
      get,
    })
  }
}
