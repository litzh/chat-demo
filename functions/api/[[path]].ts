import { handleRequest, type Env } from '../../server/app.js'

export const onRequest: PagesFunction<Env> = ({ request, env }) => handleRequest(request, env)
