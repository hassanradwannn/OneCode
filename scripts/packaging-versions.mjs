import { SUPPORTED_ARCHES, SUPPORTED_PLATFORMS } from './packaging-targets.mjs';

export { SUPPORTED_ARCHES, SUPPORTED_PLATFORMS };

/** Official Node.js 24 LTS release and SHASUMS256.txt, observed 2026-10-16. */
export const NODE_RUNTIME = Object.freeze({
  version: 'v24.22.0',
  targets: Object.freeze({
    win32: Object.freeze({
      x64: Object.freeze({ sha256: 'f9683a19877e12a9b167305c8db71040d812876359de21f0d2e97c3f321f80c3' }),
      arm64: Object.freeze({ sha256: '3a5c209a5bc59e65b3bc0fa13ed5e166a26bd3d55332847f498b76b037408d61' })
    }),
    linux: Object.freeze({
      x64: Object.freeze({ sha256: 'cc2f601cee82d9a5a233302fe307abc600727035fd7d2c3a3571755989e95008' }),
      arm64: Object.freeze({ sha256: 'fef00bb4d36e1c50104a9775a10359beee98f162b4104dd12472c75065c6a143' })
    })
  })
});

/** Ubuntu 22.04 PocketSphinx payload used by the offline Linux dictation helper. */
export const LINUX_DICTATION_RUNTIME = Object.freeze({
  id: 'ubuntu-22.04-pocketsphinx',
  pythonAbi: 'cp310',
  packages: Object.freeze({
    model: Object.freeze({
      version: '0.8.0+real5prealpha+1-14ubuntu1',
      file: 'pocketsphinx-en-us_0.8.0+real5prealpha+1-14ubuntu1_all.deb',
      path: 'pool/universe/p/pocketsphinx/pocketsphinx-en-us_0.8.0+real5prealpha+1-14ubuntu1_all.deb',
      sha256: '4fa57d7cd71fd8dd3a00f0de03f32071f84de75f78d093bd67b7cfc71350731d'
    }),
    x64: Object.freeze([
      Object.freeze({ name: 'python3-pocketsphinx', version: '0.1.15-2build5', file: 'python3-pocketsphinx_0.1.15-2build5_amd64.deb', path: 'pool/universe/p/pocketsphinx-python/python3-pocketsphinx_0.1.15-2build5_amd64.deb', sha256: '45b8f5fd151f8892294559d8477a99ee21ce7b016e1b4c494fdb74c801c847e2' }),
      Object.freeze({ name: 'python3-sphinxbase', version: '0.8+5prealpha+1-13build1', file: 'python3-sphinxbase_0.8+5prealpha+1-13build1_amd64.deb', path: 'pool/universe/s/sphinxbase/python3-sphinxbase_0.8+5prealpha+1-13build1_amd64.deb', sha256: '0f09b76aa3b0d7d7ee346904d441da8a8195a10d7bf8616859f956cbf30039bb' }),
      Object.freeze({ name: 'libpocketsphinx3', version: '0.8.0+real5prealpha+1-14ubuntu1', file: 'libpocketsphinx3_0.8.0+real5prealpha+1-14ubuntu1_amd64.deb', path: 'pool/universe/p/pocketsphinx/libpocketsphinx3_0.8.0+real5prealpha+1-14ubuntu1_amd64.deb', sha256: '3e19eb33065660f6a604d262867ff2217f48befaadb623486ec71d2ae65f38c3' }),
      Object.freeze({ name: 'libsphinxbase3', version: '0.8+5prealpha+1-13build1', file: 'libsphinxbase3_0.8+5prealpha+1-13build1_amd64.deb', path: 'pool/universe/s/sphinxbase/libsphinxbase3_0.8+5prealpha+1-13build1_amd64.deb', sha256: 'af2649a25313f10300ebbd750f81660b69126be0bdc2090f712c9543b495fbba' })
    ]),
    arm64: Object.freeze([
      Object.freeze({ name: 'python3-pocketsphinx', version: '0.1.15-2build5', file: 'python3-pocketsphinx_0.1.15-2build5_arm64.deb', path: 'pool/universe/p/pocketsphinx-python/python3-pocketsphinx_0.1.15-2build5_arm64.deb', sha256: 'b3c7f3acaf6ffb4a383d31a972444b6989d3d2929bcfdd47095f2d4412072377' }),
      Object.freeze({ name: 'python3-sphinxbase', version: '0.8+5prealpha+1-13build1', file: 'python3-sphinxbase_0.8+5prealpha+1-13build1_arm64.deb', path: 'pool/universe/s/sphinxbase/python3-sphinxbase_0.8+5prealpha+1-13build1_arm64.deb', sha256: '33f20507b2a0e572866337c01d3aabe2109161c4c86459b9b989ce769a227125' }),
      Object.freeze({ name: 'libpocketsphinx3', version: '0.8.0+real5prealpha+1-14ubuntu1', file: 'libpocketsphinx3_0.8.0+real5prealpha+1-14ubuntu1_arm64.deb', path: 'pool/universe/p/pocketsphinx/libpocketsphinx3_0.8.0+real5prealpha+1-14ubuntu1_arm64.deb', sha256: 'b3172e916cf3fad57fbc9da3bd09826d0f11ba970c601272dc950bf33d731dcd' }),
      Object.freeze({ name: 'libsphinxbase3', version: '0.8+5prealpha+1-13build1', file: 'libsphinxbase3_0.8+5prealpha+1-13build1_arm64.deb', path: 'pool/universe/s/sphinxbase/libsphinxbase3_0.8+5prealpha+1-13build1_arm64.deb', sha256: '1ee60f7ad33ee8d07974a88be6c31f53c9403d268eb7d2fadf7c86f99fc9637a' })
    ])
  })
});

export const TUNNEL_CLIENT = Object.freeze({
  version: 'v0.0.16',
  targets: Object.freeze({
    win32: Object.freeze({
      x64: Object.freeze({ upstreamArch: 'amd64', sha256: 'edef7241b0c647fcb30f1a80ff376b6b25c51927960f257a3f01e21b17c2aba6' }),
      arm64: Object.freeze({ upstreamArch: 'arm64', sha256: 'ecd748288b9bd9cc8f5a963855eb143f4788b831475156703d0bafdcd2dcb149' })
    }),
    darwin: Object.freeze({
      x64: Object.freeze({ upstreamArch: 'amd64', sha256: '57b3dd73f2d042c7aeb5664681f7538078359f55538b9e048640f1df71a0c83f' }),
      arm64: Object.freeze({ upstreamArch: 'arm64', sha256: 'a160820d45089b5253d8d671fe2a689bde0f73d78c135d1497a7b33f28a3ac62' })
    }),
    linux: Object.freeze({
      x64: Object.freeze({ upstreamArch: 'amd64', sha256: 'd60cdba019bce451bcc3a15478cc5b9cb11270b049f5b56ea39a80b517f8b117' }),
      arm64: Object.freeze({ upstreamArch: 'arm64', sha256: '963d0384aaa7c798778479c45673f9051a4039dd891aef8f8978d2a1a628b74f' })
    })
  })
});

export const RIPGREP = Object.freeze({
  version: '15.2.0',
  targets: Object.freeze({
    win32: Object.freeze({
      x64: Object.freeze({ upstreamArch: 'x86_64', triple: 'pc-windows-msvc', extension: 'zip', sha256: '71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5' }),
      arm64: Object.freeze({ upstreamArch: 'aarch64', triple: 'pc-windows-msvc', extension: 'zip', sha256: 'e4abca10c3a64ebea742667dd7009449d49403db5460dd6873e389fa2945360f' })
    }),
    darwin: Object.freeze({
      x64: Object.freeze({ upstreamArch: 'x86_64', triple: 'apple-darwin', extension: 'tar.gz', sha256: 'af7825fcc69a2afc7a7aea55fc9af90e26421d8f20fe59df32e233c0b8a231c1' }),
      arm64: Object.freeze({ upstreamArch: 'aarch64', triple: 'apple-darwin', extension: 'tar.gz', sha256: '3750b2e93f37e0c692657da574d7019a101c0084da05a790c83fd335bad973e4' })
    }),
    linux: Object.freeze({
      x64: Object.freeze({ upstreamArch: 'x86_64', triple: 'unknown-linux-musl', extension: 'tar.gz', sha256: '33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c' }),
      arm64: Object.freeze({ upstreamArch: 'aarch64', triple: 'unknown-linux-musl', extension: 'tar.gz', sha256: '800b1e7206afe799dfb5a6901f23147cfaabe0e52210538100f61e86e1740915' })
    })
  })
});
