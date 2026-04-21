class Config {
  public relay_secret: string;
  public grass_api_url: string;

  constructor(env: NodeJS.ProcessEnv) {
    this.relay_secret = this.getStringValue(env.RELAY_SECRET || "");
    this.grass_api_url = this.getStringValue(env.GRASS_API_URL || "");
  }

  private getStringValue(value: string | undefined) {
    return String(value);
  }
}

export default Config;
