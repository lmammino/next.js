import { TestingLogger } from 'next-test-utils'
import type { PlaywrightManager } from './browsers/playwright'

const logger = new TestingLogger('browser-manager')

/**
 * Browser Manager for singleton instance management.
 */
export class BrowserManager {
  private static shared?: PlaywrightManager
  private static instance?: PlaywrightManager

  /**
   * Get the singleton instance of the browser. It will be closed after each
   * test.
   *
   * @param options - The options for the browser.
   * @returns The singleton instance of the browser.
   */
  static async getInstance(options: {
    browserName: string
    locale: string
    javaScriptEnabled: boolean
    ignoreHTTPSErrors: boolean
    headless: boolean
    userAgent?: string
  }): Promise<PlaywrightManager> {
    if (this.instance) {
      logger.debug('Reusing existing browser instance')
      return this.instance
    }

    logger.debug('Creating new browser instance')

    const { PlaywrightManager } = await import('./browsers/playwright')

    this.instance = this.shared = await PlaywrightManager.setup(
      options.browserName,
      options.locale,
      options.javaScriptEnabled,
      options.ignoreHTTPSErrors,
      options.headless,
      options.userAgent
    )

    return this.instance
  }

  /**
   * Close the singleton instance of the browser (if it exists).
   */
  static async afterEach(): Promise<void> {
    if (!this.instance) return

    logger.debug('Closing browser context')

    try {
      await this.instance.closeContext()
    } catch (error) {
      logger.error('Failed to close browser instance', error as Error)
    } finally {
      this.instance = undefined
    }
  }

  static async afterAll(): Promise<void> {
    if (!this.shared) return

    logger.debug('Closing browser instance')

    try {
      await this.shared.close()
    } catch (error) {
      logger.error('Failed to close browser instance', error as Error)
    } finally {
      this.shared = undefined
    }
  }
}

// Register cleanup at module scope if afterEach is available
if (typeof afterEach === 'function') {
  afterEach(async () => {
    await BrowserManager.afterEach()
  })
}

// Register cleanup at module scope if afterAll is available
if (typeof afterAll === 'function') {
  afterAll(async () => {
    await BrowserManager.afterAll()
  })
}
