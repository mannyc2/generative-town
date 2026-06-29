# Generative Town

AI-powered procedural generator for 2D JRPG-style game maps. Give it a theme, get a complete tilemap with custom spritesheet.

![Example Output](examples/enchanted-forest/map-render.png)

## How It Works

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│   Theme          Designer Agent         Planner Agent         Renderer      │
│   "cyberpunk" ──► Spritesheet ────────► Map Layout ─────────► Final PNG     │
│                   + Metadata             (10x10 grid)                       │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Two-stage pipeline:**

1. **Designer Agent** - Generates a themed spritesheet (8x8 grid of 256px tiles) with metadata describing each sprite's category, connectivity, and placement rules
2. **Planner Agent** - Uses the metadata to intelligently place tiles, building roads with proper connectivity and placing objects contextually

## Quick Start

```bash
# Install dependencies
pnpm install

# Set up environment
cp .env.example .env
# Add your Google Generative AI API key to .env

# Generate a map
pnpm design "medieval village"
pnpm plan
```

Gemini remains the default image generator. To generate the spritesheet image
with Ideogram 4 instead, set `IMAGE_PROVIDER=ideogram`. Hosted Ideogram uses
`IDEOGRAM_MODE=api` and `IDEOGRAM_API_KEY`; local Ideogram uses
`IDEOGRAM_MODE=local` and the open-source `ideogram4/run_inference.py` script.
The Designer still uses Gemini for scene and metadata generation.

```bash
# Hosted Ideogram 4
IMAGE_PROVIDER=ideogram IDEOGRAM_MODE=api pnpm design "medieval village"

# Local Ideogram 4 clone
IMAGE_PROVIDER=ideogram \
IDEOGRAM_MODE=local \
IDEOGRAM_LOCAL_SCRIPT=/path/to/ideogram4/run_inference.py \
pnpm design "medieval village"
```

Your outputs will be in `src/agent/output/`.

## Commands

| Command | Description |
|---------|-------------|
| `pnpm design <theme>` | Generate a spritesheet for the given theme |
| `pnpm plan` | Generate a map using the existing spritesheet metadata |
| `pnpm render` | Re-render the map from existing map.json |
| `pnpm demo` | Run the full pipeline with "enchanted forest" theme |

### Options

Add `-v` or `--verbose` to any command for detailed logging:

```bash
pnpm design "haunted mansion" -v
```

## Inputs & Outputs

| Stage | Input | Output |
|-------|-------|--------|
| Design | Theme string (e.g., "cyberpunk city") | `spritesheet-*.png`, `spritesheet-metadata.json`, `scene-description.md` |
| Plan | Spritesheet metadata | `map.json` |
| Render | Map + Spritesheet | `map-render.png` |

### Output Files

```
src/agent/output/
├── spritesheet-*.png           # 2048x2048 spritesheet (8x8 grid of 256px tiles)
├── spritesheet-metadata.json   # Sprite definitions with connectivity info
├── scene-description.md        # LLM-generated theme narrative
├── prompt.md                   # Prompt sent to image generator
├── map.json                    # Tile placement data
└── map-render.png              # Final rendered map
```

## Examples

See the [examples/](examples/) folder for pre-generated outputs:

- [Enchanted Forest](examples/enchanted-forest/) - Mystical woodland with glowing paths
- [Medieval Village](examples/medieval-village/) - Classic fantasy village
- [Cyberpunk City](examples/cyberpunk-city/) - Neon-lit urban streets

## Requirements

- Node.js 18+
- pnpm
- [Google Generative AI API key](https://aistudio.google.com/apikey) (Gemini)
- Optional: [Ideogram API key](https://developer.ideogram.ai/ideogram-api/api-setup) for `IMAGE_PROVIDER=ideogram` with `IDEOGRAM_MODE=api`
- Optional: local [Ideogram 4](https://github.com/ideogram-oss/ideogram4) checkout for `IMAGE_PROVIDER=ideogram` with `IDEOGRAM_MODE=local`

## How the Agents Work

### Designer Agent Phases

1. **Scene Phase** - LLM generates a detailed narrative description of the theme
2. **Spritesheet Phase** - LLM outputs sprite metadata (IDs, coordinates, descriptions, connectivity rules)
3. **Image Generation** - Gemini generates the actual spritesheet PNG
4. **Post-processing** - Transparent background applied

### Planner Agent Phases

1. **Ground Phase** - Fills base terrain tiles
2. **Roads Phase** - Places connected road/path tiles respecting connectivity metadata
3. **Objects Phase** - Places buildings, props, and decorations

Each sprite includes connectivity metadata (which sides connect to roads/paths) enabling the Planner to build coherent road networks.

## License

MIT
