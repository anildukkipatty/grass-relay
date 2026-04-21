const dotenv = require("dotenv");
dotenv.config();

import Config from "./config";

const config = new Config(process.env);

export { config };
