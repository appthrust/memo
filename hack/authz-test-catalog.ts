// Ink-only, one-entry catalog. Never submits to Cloud or touches Memo's image tags.
// Dry-run retains its temporary directory for offline reader compatibility checks.
import { createHash } from 'node:crypto'
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { YAML } from 'bun'
import { validateRelease, type CatalogEntry } from './publish-entry'

export const repository = 'ghcr.io/appthrust/memo'
export const catalogTag = 'authz-test-catalog'
export const artifactType = 'application/vnd.appthrust.app-catalog.v1+json'
const definitionTitle = 'definitions/authz-probe.yaml'

interface Definition {
  apiVersion: string
  kind: string
  metadata: { name: string }
  spec: {
    display: { category: string }
    updatePolicy: CatalogEntry['updatePolicy']
    versions?: Array<CatalogVersion & { served: boolean }>
  }
}

interface CatalogVersion {
  name: string
  images: { web: string }
  stream: string
  default: boolean
}

export interface CatalogPublication {
  index: {
    schemaVersion: number
    publishedAt: string
    entries: Array<{
      slug: string
      definition: { digest: string }
      versions: CatalogVersion[]
      updatePolicy: CatalogEntry['updatePolicy']
      display: { category: string }
    }>
  }
  layers: Array<{ title: string; mediaType: string; content: string; digest: string; size: number }>
}

function sha256(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`
}

export function renderCatalog(template: string, version: string, digest: string, publishedAt = new Date().toISOString()): CatalogPublication {
  validateRelease(version, digest)
  const definition = YAML.parse(template) as Definition
  if (definition.apiVersion !== 'appthrust.io/v1alpha1' || definition.kind !== 'ApplicationStackDefinition' || definition.metadata.name !== 'authz-probe') {
    throw new Error('template must be the authz-probe ApplicationStackDefinition')
  }
  const selected: CatalogVersion = {
    name: version,
    images: { web: `${repository}@${digest}` },
    stream: version.split('.').slice(0, 2).join('.'),
    default: true,
  }
  // Served belongs to the definition, not pkg/appcatalog.Version in the index.
  definition.spec.versions = [{ ...selected, served: true }]
  const definitionYAML = YAML.stringify(definition)
  const index = {
    schemaVersion: 1,
    publishedAt,
    entries: [{
      slug: 'authz-probe',
      definition: { digest: sha256(definitionYAML) },
      versions: [selected],
      updatePolicy: definition.spec.updatePolicy,
      display: { category: definition.spec.display.category },
    }],
  }
  const layers = [
    { title: 'index.json', mediaType: 'application/json', content: `${JSON.stringify(index, null, 2)}\n` },
    { title: definitionTitle, mediaType: 'application/yaml', content: definitionYAML },
  ].map(layer => ({ ...layer, digest: sha256(layer.content), size: Buffer.byteLength(layer.content) }))
  return { index, layers }
}

// Match Cloud's oras flags and created annotation, but isolate every tag from Memo.
// Sign the immutable digest before moving the only AppCatalogSource pointer.
export function publicationPlan(publication: CatalogPublication, manifestDigest: string): string[][] {
  const reference = `${repository}@${manifestDigest}`
  return [
    ['oras', 'push', '--format', 'json', '--artifact-type', artifactType,
      '--annotation', `org.opencontainers.image.created=${publication.index.publishedAt}`,
      `${repository}:authz-test-index-${publication.layers[0]!.digest.slice(7)}`,
      ...publication.layers.map(layer => `${layer.title}:${layer.mediaType}`)],
    ['cosign', 'sign', '--yes', reference],
    ['oras', 'tag', reference, catalogTag],
  ]
}

async function run(args: string[], cwd: string): Promise<string> {
  const command = Bun.spawn(args, { cwd, stdout: 'pipe', stderr: 'inherit' })
  const text = await new Response(command.stdout).text()
  if (await command.exited !== 0) throw new Error(`${args[0]} ${args[1]} failed`)
  return text
}

async function main(): Promise<void> {
  const { values } = parseArgs({ args: Bun.argv.slice(2), strict: true, options: {
    version: { type: 'string' }, digest: { type: 'string' }, 'dry-run': { type: 'boolean', default: false },
  } })
  if (!values.version || !values.digest) {
    throw new Error('usage: bun hack/authz-test-catalog.ts --version <semver> --digest <sha256:hex> [--dry-run]')
  }
  const template = await Bun.file(new URL('../catalog/authz-probe.yaml', import.meta.url)).text()
  const publication = renderCatalog(template, values.version, values.digest)
  if (!values['dry-run'] && !process.env.ACTIONS_ID_TOKEN_REQUEST_URL) {
    throw new Error('Sigstore keyless signing requires GitHub Actions OIDC')
  }
  const directory = await mkdtemp(join(tmpdir(), 'authz-test-catalog-'))
  try {
    await mkdir(join(directory, 'definitions'))
    for (const layer of publication.layers) await writeFile(join(directory, layer.title), layer.content)
    if (values['dry-run']) {
      console.log(`Dry-run files: ${directory}`)
      console.log('Run these argv in that directory; CATALOG_DIGEST is the digest returned by oras push:')
      for (const args of publicationPlan(publication, '$CATALOG_DIGEST')) console.log(JSON.stringify(args))
      console.log('No registry or signing requests made. Remove the directory after offline verification.')
      return
    }
    const [push] = publicationPlan(publication, '')
    const descriptor = JSON.parse(await run(push!, directory)) as { digest: string }
    if (!/^sha256:[a-f0-9]{64}$/.test(descriptor.digest) || descriptor.digest === `sha256:${'0'.repeat(64)}`) {
      throw new Error('oras did not return a manifest digest')
    }
    const [, sign, tag] = publicationPlan(publication, descriptor.digest)
    await run(sign!, directory)
    await run(tag!, directory)
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `digest=${descriptor.digest}\n`)
    console.log(`${repository}@${descriptor.digest}`)
  } finally {
    if (!values['dry-run']) await rm(directory, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
