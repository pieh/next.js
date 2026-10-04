import { nextTestSetup } from 'e2e-utils'

describe('app-dir root layout render once', () => {
  const { next } = nextTestSetup({
    files: __dirname,
  })

  it('should only render root layout once', async () => {
    // a deployed instance may have rendered the layout before (e.g. for a deploy
    // preview screenshot), so count from the first value seen
    let $ = await next.render$('/render-once')
    const start = Number($('#counter').text())
    $ = await next.render$('/render-once')
    expect($('#counter').text()).toBe(String(start + 1))
    $ = await next.render$('/render-once')
    expect($('#counter').text()).toBe(String(start + 2))
  })
})
