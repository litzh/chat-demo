import { randomBytes, pbkdf2Sync } from 'node:crypto'
import { createInterface } from 'node:readline/promises'
import { Writable } from 'node:stream'
// Never take passwords in command-line arguments or write plaintext into configuration.
const output = new Writable({
  write(_chunk, _encoding, done) {
    done()
  },
})
const rl = createInterface({ input: process.stdin, output, terminal: true })
process.stderr.write('设置管理员密码（至少 12 个字符，输入不回显）：')
const password = await rl.question('')
rl.close()
process.stderr.write('\n')
if (password.length < 12) {
  process.stderr.write('密码至少需要 12 个字符\n')
  process.exit(1)
}
const salt = randomBytes(16)
const hash = pbkdf2Sync(password, salt, 100000, 32, 'sha256')
process.stdout.write(`pbkdf2$100000$${salt.toString('hex')}$${hash.toString('hex')}\n`)
