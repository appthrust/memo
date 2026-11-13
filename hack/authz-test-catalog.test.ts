import { describe, expect, test } from 'bun:test'
import { YAML } from 'bun'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { artifactType, catalogTag, publicationPlan, renderCatalog, repository } from './authz-test-catalog'

const template = await Bun.file(new URL('../catalog/authz-probe.yaml', import.meta.url)).text()
const digest = `sha256:${'a'.repeat(64)}`
const publishedAt = '2026-11-13T00:00:00.000Z'
const sha256 = (content: string) => `sha256:${createHash('sha256').update(content).digest('hex')}`
const policy = { allowed: ['pinned'], default: 'pinned' }
const version = { name: '0.1.0', images: { web: `${repository}@${digest}` }, stream: '0.1', default: true }

describe('authz-test catalog rendering', () => {
  test('emits exactly the reader index fields and two ordered, digest-matched layers', () => {
    const publication = renderCatalog(template, '0.1.0', digest, publishedAt)
    expect(artifactType).toBe('application/vnd.appthrust.app-catalog.v1+json')
    expect(publication.layers.map(({ title, mediaType }) => ({ title, mediaType }))).toEqual([
      { title: 'index.json', mediaType: 'application/json' },
      { title: 'definitions/authz-probe.yaml', mediaType: 'application/yaml' },
    ])
    const [index, definition] = publication.layers
    expect(publication.index).toEqual({
      schemaVersion: 1,
      publishedAt,
      entries: [{
        slug: 'authz-probe',
        definition: { digest: sha256(definition!.content) },
        versions: [version],
        updatePolicy: policy,
        display: { category: 'collaborate' },
      }],
    })
    expect(JSON.parse(index!.content)).toEqual(publication.index)
    expect(publication.index.entries[0]!.definition.digest).toBe(definition!.digest)
    for (const layer of publication.layers) {
      expect(layer.digest).toBe(sha256(layer.content))
      expect(layer.size).toBe(Buffer.byteLength(layer.content))
      expect(layer.size).toBeGreaterThan(0)
    }
  })

  test('strict definition field set contains only the dependency-free OIDC probe and access vocabulary', () => {
    const publication = renderCatalog(template, '0.1.0', digest, publishedAt)
    const definition = YAML.parse(publication.layers[1]!.content)
    expect(definition).toEqual({
      apiVersion: 'appthrust.io/v1alpha1',
      kind: 'ApplicationStackDefinition',
      metadata: { name: 'authz-probe' },
      spec: {
        access: {
          audiences: ['appthrust-platform-api'],
          scopes: ['openid', 'profile', 'email'],
          tokenClaims: ['groups'],
          permissions: [{ name: 'probe:read' }, { name: 'probe:write' }, { name: 'probe:admin' }],
          roles: [
            { name: 'viewer', permissions: ['probe:read'] },
            { name: 'editor', permissions: ['probe:read', 'probe:write'] },
            { name: 'admin', permissions: ['probe:read', 'probe:write', 'probe:admin'] },
          ],
          defaultBindings: [
            { role: 'admin', subject: { kind: 'ProjectAccess', action: 'project.manage' } },
            { role: 'viewer', subject: { kind: 'Authenticated' } },
          ],
        },
        components: [{
          id: 'web',
          definitionRef: { name: 'web-service', version: 'v1' },
          defaultValues: { livenessProbePath: '/healthz', minScale: 1, port: 8080, readinessProbePath: '/healthz' },
        }],
        display: { category: 'collaborate', description: 'Test fixture for application roles and bindings on appthrust.ink.', title: 'Authz Probe' },
        publish: { hostnameLabel: 'authz-probe' },
        releaseIdentityEnvPrefix: 'PROBE',
        updatePolicy: policy,
        versions: [{ ...version, served: true }],
      },
    })
    // These mirror the permission/role references and name patterns in the CRD CEL/schema.
    const { permissions, roles, defaultBindings } = definition.spec.access
    for (const permission of permissions) expect(permission.name).toMatch(/^[a-z][a-z0-9-]*(:[a-z][a-z0-9-]*)?$/)
    for (const role of roles) {
      expect(role.name).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/)
      for (const permission of role.permissions) expect(permissions.map((p: { name: string }) => p.name)).toContain(permission)
    }
    for (const binding of defaultBindings) {
      expect(roles.map((role: { name: string }) => role.name)).toContain(binding.role)
      expect(Object.hasOwn(binding.subject, 'action')).toBe(binding.subject.kind === 'ProjectAccess')
    }
  })

  test('updates only this fixture version without leaking served into the index', () => {
    const publication = renderCatalog(template, '0.2.3-rc.1', digest, publishedAt)
    expect(publication.index.entries[0]!.versions).toEqual([
      { ...version, name: '0.2.3-rc.1', stream: '0.2' },
    ])
    expect(YAML.parse(template).spec.versions).toBeUndefined()
  })

  test('rejects invalid coordinates and any other app template', () => {
    for (const value of ['v0.1.0', '0.1', '0.1.0+build', '0.1.0-01', '../memo', '0.1.0\n']) {
      expect(() => renderCatalog(template, value, digest)).toThrow('version must be SemVer')
    }
    for (const value of ['latest', `sha256:${'0'.repeat(64)}`, `sha256:${'A'.repeat(64)}`, 'sha256:abc']) {
      expect(() => renderCatalog(template, '0.1.0', value)).toThrow('digest must be a non-placeholder sha256 image index digest')
    }
    expect(() => renderCatalog(template.replace('name: authz-probe', 'name: memo'), '0.1.0', digest)).toThrow('template must be the authz-probe ApplicationStackDefinition')
  })
})

test('publication uses Cloud oras flags, signs before tagging, and never moves Memo or latest tags', () => {
  const publication = renderCatalog(template, '0.1.0', digest, publishedAt)
  const manifestDigest = `sha256:${'b'.repeat(64)}`
  expect(publicationPlan(publication, manifestDigest)).toEqual([
    ['oras', 'push', '--format', 'json', '--artifact-type', artifactType,
      '--annotation', `org.opencontainers.image.created=${publishedAt}`,
      `${repository}:authz-test-index-${publication.layers[0]!.digest.slice(7)}`,
      'index.json:application/json', 'definitions/authz-probe.yaml:application/yaml'],
    ['cosign', 'sign', '--yes', `${repository}@${manifestDigest}`],
    ['oras', 'tag', `${repository}@${manifestDigest}`, 'authz-test-catalog'],
  ])
})

test('operator source trusts only the main-branch workflow and is task-owned', async () => {
  const source = YAML.parse(await Bun.file(new URL('authz-test/appcatalogsource.yaml', import.meta.url)).text())
  expect(source).toEqual({
    apiVersion: 'platform.appthrust.io/v1alpha1', kind: 'AppCatalogSource',
    metadata: { name: 'authz-test', labels: { 'appthrust.io/task': 'apt-844' } },
    spec: {
      repository, tag: catalogTag, pollInterval: '5m',
      signerIdentity: {
        issuer: 'https://token.actions.githubusercontent.com',
        subjectRegexp: '^https://github\\.com/appthrust/memo/\\.github/workflows/authz-probe\\.yml@refs/heads/main$',
      },
    },
  })
  const subject = 'https://github.com/appthrust/memo/.github/workflows/authz-probe.yml@refs/heads/main'
  const trusted = new RegExp(source.spec.signerIdentity.subjectRegexp)
  expect(trusted.test(subject)).toBe(true)
  for (const value of [`prefix${subject}`, `${subject}/extra`, subject.replace('main', 'feature'), subject.replace('authz-probe.yml', 'publish.yml'), subject.replace('github.com', 'githubXcom')]) {
    expect(trusted.test(value)).toBe(false)
  }
})

test('workflow is manual, main-only, multi-arch and verifies the exact signing identity', async () => {
  const workflow = YAML.parse(await Bun.file(new URL('../.github/workflows/authz-probe.yml', import.meta.url)).text())
  expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch'])
  expect(workflow.on.workflow_dispatch.inputs.version.default).toBe('0.1.0')
  expect(workflow.permissions).toEqual({ contents: 'read', packages: 'write', 'id-token': 'write' })
  expect(workflow.jobs.publish.if).toBe("github.repository == 'appthrust/memo' && github.ref == 'refs/heads/main'")
  const steps = workflow.jobs.publish.steps as Array<{ name?: string; uses?: string; run?: string; with?: Record<string, string> }>
  for (const step of steps.filter(step => step.uses)) expect(step.uses).toMatch(/@[a-f0-9]{40}$/)
  expect(steps.find(step => step.uses?.startsWith('oras-project/setup-oras@'))!.with!.version).toBe('1.3.0')
  expect(steps.find(step => step.uses?.startsWith('sigstore/cosign-installer@'))!.with!['cosign-release']).toBe('v3.1.3')
  const build = steps.find(step => step.name === 'Build and push both architectures')!.run!
  expect(build).toContain('--platform linux/amd64,linux/arm64 --push')
  expect(build).toContain('--file Dockerfile.authz-probe --build-arg "VERSION=$VERSION"')
  expect(build).toContain('--tag "ghcr.io/appthrust/memo:authz-probe-$VERSION"')
  const verify = steps.find(step => step.name === 'Verify the signed catalog')!.run!
  expect(verify).toContain("--certificate-identity 'https://github.com/appthrust/memo/.github/workflows/authz-probe.yml@refs/heads/main'")
  expect(verify).toContain("--certificate-oidc-issuer 'https://token.actions.githubusercontent.com'")
  expect(verify).toContain('"$GITHUB_STEP_SUMMARY"')
})

test('dry-run writes matching bytes and prints argv without any external publisher executable', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'authz-test-catalog-test-'))
  try {
    const command = Bun.spawn([process.execPath, fileURLToPath(new URL('authz-test-catalog.ts', import.meta.url)),
      '--version', '0.1.0', '--digest', digest, '--dry-run'], {
      env: { PATH: '', TMPDIR: temporary }, stdout: 'pipe', stderr: 'pipe',
    })
    const stdout = await new Response(command.stdout).text()
    const stderr = await new Response(command.stderr).text()
    expect(await command.exited).toBe(0)
    expect(stderr).toBe('')
    const directory = stdout.match(/^Dry-run files: (.+)$/m)![1]!
    expect((await readdir(directory)).sort()).toEqual(['definitions', 'index.json'])
    const index = JSON.parse(await Bun.file(join(directory, 'index.json')).text())
    const definition = await Bun.file(join(directory, 'definitions/authz-probe.yaml')).text()
    expect(index.entries[0].definition.digest).toBe(sha256(definition))
    expect(index.entries[0].versions).toEqual([version])
    const commands = stdout.split('\n').filter(line => line.startsWith('[')).map(line => JSON.parse(line))
    expect(commands).toEqual(publicationPlan(renderCatalog(template, '0.1.0', digest, index.publishedAt), '$CATALOG_DIGEST'))
    expect(stdout).toContain('No registry or signing requests made.')
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})
