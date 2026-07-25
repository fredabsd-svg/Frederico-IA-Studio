// Como o backend alcança o Docker — e por que isso precisa ser visível.
//
// O achado F-04 era o backend deter /var/run/docker.sock (equivalente a root no
// host). A correção põe o serviço docker-guard no caminho. Estes testes travam
// as duas pontas: a configuração é lida do ambiente e o modo vigente aparece no
// /api/health, para o operador não descobrir por acaso que está sem o guarda.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'fred-docker-access-'));

test('com DOCKER_HOST, o backend fala com o guarda (e diz isso no health)', async () => {
  process.env.DOCKER_HOST = 'tcp://docker-guard:2375';
  const { dockerAccessMode } = await import(`./sandbox.js?guarda=${Date.now()}`);
  const modo = dockerAccessMode();
  assert.equal(modo.modo, 'guarda');
  assert.equal(modo.destino, 'tcp://docker-guard:2375');
});

test('sem DOCKER_HOST, o modo é socket direto — o estado que o F-04 descreve', async () => {
  delete process.env.DOCKER_HOST;
  const { dockerAccessMode } = await import(`./sandbox.js?socket=${Date.now()}`);
  const modo = dockerAccessMode();
  assert.equal(modo.modo, 'socket-direto');
  assert.match(modo.destino, /docker\.sock$/);
});
