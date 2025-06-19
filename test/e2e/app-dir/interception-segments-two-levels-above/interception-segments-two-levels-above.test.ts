import { nextTestSetup } from 'e2e-utils'
import { retry } from 'next-test-utils'

describe('interception-segments-two-levels-above', () => {
  const { next } = nextTestSetup({
    files: __dirname,
  })

  it('should work when interception route is paired with segments two levels above', async () => {
    const browser = await next.browser('/foo/bar')

    await browser.elementByCss('[href="/hoge"]').click()
    await retry(async () => {
      expect(await browser.elementById('intercepted').text()).toMatch(
        /intercepted/
      )
    })
  })
})
