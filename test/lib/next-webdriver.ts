import { getFullUrl, TestingLogger, waitFor } from 'next-test-utils'
import os from 'node:os'
import { setTimeout } from 'node:timers/promises'
import { Playwright } from './browsers/playwright'
import { Page } from 'playwright'
import { BrowserManager } from './browser-manager'

export type { Playwright }

// Constants
const CONSTANTS = {
  HYDRATION_TIMEOUT: 10_000,
  RETRY_DELAY: 2_000,
  TURBOPACK_DELAY: 1_000,
  DEFAULT_BROWSER: 'chrome',
  IPV4_FAMILY: 'IPv4' as const,
} as const

// Type definitions
interface NextWindow extends Window {
  __NEXT_HYDRATED?: boolean
  __NEXT_HYDRATED_CB?: () => void
  next?: {
    version: string
  }
}

interface GlobalWithBrowser {
  browserName: string
}

// Custom error classes
class BrowserSetupError extends Error {
  constructor(
    message: string,
    public cause?: Error
  ) {
    super(message)
    this.name = 'BrowserSetupError'
  }
}

class HydrationTimeoutError extends Error {
  constructor(public url: string) {
    super(`Hydration timeout for ${url}`)
    this.name = 'HydrationTimeoutError'
  }
}

if (!process.env.TEST_FILE_PATH) {
  process.env.TEST_FILE_PATH = module.parent!.filename
}

const logger = new TestingLogger('next-webdriver')

// Utility functions
function getDeviceIPv4Address(): string | undefined {
  const nets = os.networkInterfaces()
  for (const interfaces of Object.values(nets)) {
    const ipv4 = interfaces?.find(
      (item) => item.family === CONSTANTS.IPV4_FAMILY && !item.internal
    )
    if (ipv4) return ipv4.address
  }
  return undefined
}

async function waitForHydration(
  page: Playwright,
  url: string,
  options: { retry?: boolean } = {}
): Promise<void> {
  logger.debug(`Waiting hydration for ${url}`)

  const checkHydrated = async () => {
    await page.eval(() => {
      return new Promise<void>((callback) => {
        const win = window as NextWindow

        // if it's not a Next.js app return
        if (
          !document.documentElement.innerHTML.includes('__NEXT_DATA__') &&
          typeof win.next?.version === 'undefined'
        ) {
          console.log('Not a next.js page, resolving hydrate check')
          return callback()
        }

        // TODO: should we also ensure router.isReady is true
        // by default before resolving?
        if (win.__NEXT_HYDRATED) {
          console.log('Next.js page already hydrated')
          return callback()
        } else {
          const timeout = win.setTimeout(callback, CONSTANTS.HYDRATION_TIMEOUT)
          win.__NEXT_HYDRATED_CB = function () {
            win.clearTimeout(timeout)
            console.log('Next.js hydrate callback fired')
            callback()
          }
        }
      })
    })
  }

  try {
    await checkHydrated()
  } catch (err) {
    if (options.retry) {
      // re-try in case the page reloaded during check
      await setTimeout(CONSTANTS.RETRY_DELAY)
      await checkHydrated()
    } else {
      logger.error('Failed to check hydration', err as Error)
      throw err
    }
  }

  logger.debug(`Hydration complete for ${url}`)
}

let deviceIP: string | undefined
const isBrowserStack = !!process.env.BROWSERSTACK
;(global as GlobalWithBrowser & typeof globalThis).browserName =
  process.env.BROWSER_NAME || CONSTANTS.DEFAULT_BROWSER

if (isBrowserStack) {
  deviceIP = getDeviceIPv4Address()
  if (!deviceIP) {
    logger.warn('Could not detect IPv4 address for BrowserStack')
  }
}

export interface WebdriverOptions {
  /**
   * whether to wait for React hydration to finish
   */
  waitHydration?: boolean
  /**
   * allow retrying hydration wait if reload occurs
   */
  retryWaitHydration?: boolean
  /**
   * disable cache for page load
   */
  disableCache?: boolean
  /**
   * the callback receiving page instance before loading page
   * @param page
   * @returns
   */
  beforePageLoad?: (page: Page) => void
  /**
   * browser locale
   */
  locale?: string
  /**
   * disable javascript
   */
  disableJavaScript?: boolean
  headless?: boolean
  /**
   * ignore https errors
   */
  ignoreHTTPSErrors?: boolean
  cpuThrottleRate?: number
  pushErrorAsConsoleLog?: boolean

  /**
   * Override the user agent
   */
  userAgent?: string
}

/**
 * Creates or reuses a browser instance for testing.
 *
 * The browser instance is managed as a singleton - multiple calls will reuse
 * the same browser instance for performance. The browser is automatically
 * cleaned up after all tests complete.
 *
 * @param appPortOrUrl can either be the port or the full URL
 * @param url the path/query to append when using appPort
 * @param options configuration options for the browser
 * @returns thenable browser instance with the loaded page
 */
export default async function webdriver(
  appPortOrUrl: string | number,
  url: string,
  options?: WebdriverOptions
): Promise<Playwright> {
  const defaultOptions = {
    waitHydration: true,
    retryWaitHydration: false,
    disableCache: false,
  }
  const mergedOptions = Object.assign({}, defaultOptions, options)
  const {
    waitHydration,
    retryWaitHydration,
    disableCache,
    beforePageLoad,
    locale,
    disableJavaScript,
    ignoreHTTPSErrors,
    headless,
    cpuThrottleRate,
    pushErrorAsConsoleLog,
    userAgent,
  } = mergedOptions

  const browserName = process.env.BROWSER_NAME || CONSTANTS.DEFAULT_BROWSER
  ;(global as GlobalWithBrowser & typeof globalThis).browserName = browserName

  const fullUrl = getFullUrl(
    appPortOrUrl,
    url,
    isBrowserStack ? deviceIP : 'localhost'
  )

  try {
    logger.debug(`Loading browser with ${fullUrl}`)

    const playwright = await BrowserManager.getInstance({
      browserName,
      locale: locale || 'en-US',
      javaScriptEnabled: !disableJavaScript,
      ignoreHTTPSErrors: Boolean(ignoreHTTPSErrors),
      // allow headless to be overwritten for a particular test
      headless:
        typeof headless !== 'undefined' ? headless : !!process.env.HEADLESS,
      userAgent,
    })

    const page = await playwright.newPage(fullUrl, {
      disableCache,
      cpuThrottleRate,
      beforePageLoad,
      pushErrorAsConsoleLog,
    })
    logger.debug(`Loaded browser with ${fullUrl}`)

    // Wait for application to hydrate
    if (waitHydration) {
      try {
        await waitForHydration(page, fullUrl, { retry: retryWaitHydration })
      } catch (error) {
        if (error instanceof HydrationTimeoutError) {
          throw error
        }
        throw new BrowserSetupError(
          'Failed to wait for hydration',
          error as Error
        )
      }
    }

    // This is a temporary workaround for turbopack starting watching too late.
    // So we delay file changes to give it some time
    // to connect the WebSocket and start watching.
    if (process.env.IS_TURBOPACK_TEST) {
      await waitFor(CONSTANTS.TURBOPACK_DELAY)
    }

    return page
  } catch (error) {
    const errorMessage = `Failed to setup browser for ${fullUrl}`
    logger.error(errorMessage, error as Error)
    throw new BrowserSetupError(errorMessage, error as Error)
  }
}
