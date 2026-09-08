import { replaceDestination } from '../destination'

function matchesOf(regex: RegExp, input: string): RegExpMatchArray {
  const matches = input.match(regex)
  if (!matches) {
    throw new Error(`expected ${input} to match ${regex}`)
  }
  return matches
}

describe('replaceDestination', () => {
  it('replaces numbered and named captures', () => {
    const matches = matchesOf(/^\/(?<id>[^/]+?)\/([^/]+?)$/, '/a/b')
    expect(replaceDestination('/$id/$2?id=$id', matches, {})).toBe('/a/b?id=a')
  })

  it('does not let a capture name corrupt one it is a prefix of', () => {
    const matches = matchesOf(
      /^\/(?<nxtPid>[^/]+?)\/(?<nxtPid2>[^/]+?)$/,
      '/a/b'
    )
    expect(
      replaceDestination(
        '/[id]/[id2]?nxtPid=$nxtPid&nxtPid2=$nxtPid2',
        matches,
        {}
      )
    ).toBe('/[id]/[id2]?nxtPid=a&nxtPid2=b')
  })

  it('does not let $1 corrupt $10', () => {
    const input = '/a/b/c/d/e/f/g/h/i/j'
    const matches = matchesOf(
      /^\/(.+?)\/(.+?)\/(.+?)\/(.+?)\/(.+?)\/(.+?)\/(.+?)\/(.+?)\/(.+?)\/(.+?)$/,
      input
    )
    expect(replaceDestination('/$10/$1', matches, {})).toBe('/j/a')
  })

  it('does not re-substitute placeholders coming from a value', () => {
    const matches = matchesOf(/^\/(?<slug>.+?)$/, '/$2')
    expect(replaceDestination('/$slug', matches, {})).toBe('/$2')
  })

  it('prefers a regex group over a has capture of the same name', () => {
    const matches = matchesOf(/^\/(?<token>[^/]+?)$/, '/from-path')
    expect(replaceDestination('/$token', matches, { token: 'from-has' })).toBe(
      '/from-path'
    )
  })

  it('replaces has captures and leaves unknown placeholders untouched', () => {
    expect(replaceDestination('/$token$rscSuffix', null, { token: 'a' })).toBe(
      '/a$rscSuffix'
    )
  })
})
