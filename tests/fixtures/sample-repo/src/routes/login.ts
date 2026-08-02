import { Router } from 'express';
import { signToken } from '../auth/jwt.js';
import { findUser } from '../services/users.js';

export const loginRouter = Router();

loginRouter.post('/login', async (request, response) => {
  const user = await findUser(request.body.email);
  if (user === null) {
    response.status(401).json({ error: 'invalid credentials' });
    return;
  }
  response.json({ token: signToken(user.id) });
});
