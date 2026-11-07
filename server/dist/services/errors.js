export class HttpError extends Error {
    status;
    details;
    constructor(status, message, details) {
        super(message);
        this.status = status;
        this.details = details;
    }
}
export const notFound = (what) => new HttpError(404, `${what} not found.`);
export const badRequest = (msg, details) => new HttpError(400, msg, details);
export const conflict = (msg, details) => new HttpError(409, msg, details);
