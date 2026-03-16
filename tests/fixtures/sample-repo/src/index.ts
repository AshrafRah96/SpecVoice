// Entry point for sample application
import { greet } from './utils/helpers'
import type { User } from './models/user'

const user: User = { id: '1', name: 'Alice', email: 'alice@example.com' }
// TODO: wire up to actual data source
console.log(greet(user.name))
