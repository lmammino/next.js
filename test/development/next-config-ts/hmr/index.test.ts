import { nextTestSetup } from 'e2e-utils'
import { retry } from 'next-test-utils'

describe('next-config-ts - dev-hmr', () => {
  const { next } = nextTestSetup({
    files: __dirname,
  })
  it('should output config file change', async () => {
    await retry(async () => {
      expect(next.cliOutput).toMatch(/ready/i)
    })

    await retry(async () => {
      await next.patchFile('next.config.ts', (content) => {
        return content.replace(
          '// target',
          `async redirects() {
            return [
              {
                source: '/about',
                destination: '/',
                permanent: false,
              },
            ]
          },`
        )
      })
      expect(next.cliOutput).toMatch(
        /Found a change in next\.config\.ts\. Restarting the server to apply the changes\.\.\./
      )
    })

    await retry(async () => {
      expect(await next.fetch('/about').then((res) => res.status)).toBe(200)
    })
  })
})
