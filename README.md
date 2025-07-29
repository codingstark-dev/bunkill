# BunKill 🚀 - npkill alternative

**Ultra-fast node_modules cleanup tool powered by Bun.js**

> Faster than npkill with advanced interactive features and accurate size reporting

## ✨ Features

- **Ultra-fast scanning** using Bun.js native APIs and optimized glob patterns
- **Accurate size calculation** with fallback mechanisms for all platforms
- **Interactive CLI** with pagination and keyboard navigation
- **Real-time progress** display during scanning
- **Smart filtering** with skip patterns and hidden directory exclusion
- **Batch operations** with multi-select and confirmation
- **Cross-platform** support (macOS ✅, Linux/Windows 🔜)
- **Zero external runtime dependencies** - uses only Bun.js built-ins and TypeScript


## 📦 Installation

### Quick Install (Recommended)
```bash
# Install globally via npm
npm install -g bunkill

# Or install via Bun
bun install -g bunkill
```

### From Source
```bash
# Clone the repository
git clone https://github.com/codingstark-dev/bunkill.git
cd bunkill

# Install dependencies
bun install

# Make executable
chmod +x index.ts

# Create symlink for global access
sudo ln -s $(pwd)/index.ts /usr/local/bin/bunkill

# Or build for distribution
bun build index.ts --outfile=bunkill --target=bun --minify
```

### One-liner Install
```bash
curl -fsSL https://raw.githubusercontent.com/codingstark-dev/bunkill/main/install.sh | bash
```

## 📋 Requirements

### System Requirements
- **Bun.js** v1.0 or higher (required runtime)
- **Node.js** (optional, for npm installation)
- **Operating System**: macOS (fully tested), Linux/Windows (next priority)
- **Terminal**: Any modern terminal with ANSI color support

### Installation Prerequisites
```bash
# Install Bun.js (if not already installed)
curl -fsSL https://bun.sh/install | bash

# Verify installation
bun --version

# Install TypeScript types (for development)
bun add -d @types/bun
```

## 🎯 Usage

### Basic Usage
```bash
# Scan current directory (interactive mode)
bunkill

# Scan specific directory
bunkill --dir /path/to/projects

# Using without global installation
bunx bunkill                    # Via Bun
npx bunkill                     # Via npm

# Quick scan with immediate results
bunkill --depth 1
```

### Command Line Options
```bash
# Scan current directory with custom depth
bunkill --depth 3

# Full system scan (scan home directory)
bunkill --full-scan

# Dry run - show what would be deleted without actually deleting
bunkill --dry-run

# Delete all found node_modules without confirmation (USE WITH CAUTION!)
bunkill --delete-all

# Exclude specific directories from scan
bunkill --exclude .git build dist

# Hide permission errors during scanning
bunkill --hide-errors

# Exclude hidden directories from scan
bunkill --exclude-hidden

# Scan for specific target directory (default: node_modules)
bunkill --target vendor
```

### Running from Source
```bash
# If installed from source, use bun run
bun run index.ts --help
bun run index.ts --dir ~/Projects --depth 2
```

## ⌨️ Interactive Mode

When running without `--delete-all` or `--dry-run`, BunKill enters interactive mode:

### Navigation & Controls
- **↑/↓** - Navigate up/down through results
- **Page Up/Down** - Scroll by page
- **Home/End** - Jump to first/last item

### Selection & Actions
- **Space** - Toggle selection of current item
- **a** - Select/deselect all items
- **Enter** - Delete selected items (with confirmation)
- **d** - Delete current item (with confirmation)
- **q** - Quit application

### Sorting & Filtering
- **s** - Cycle sort order (size → date → path)
- **f** - Toggle filter mode
- **r** - Refresh scan results

### Visual Indicators
- **Green** ✅ - Selected for deletion
- **Red** ❌ - Large directories (>100MB)
- **Yellow** ⚠️ - Recently modified (<7 days)
- **Gray** 📁 - Hidden directories

## 🔍 Examples

### Real-world Usage Scenarios

#### Clean up development projects
```bash
# Scan all projects in home directory
bunkill --dir ~/Projects --depth 3

# Find large node_modules directories only
bunkill --dir ~/Projects --depth 2 | grep -E "[0-9]+\.[0-9]+\s*[MG]B"
```

#### System cleanup
```bash
# Full system scan (be careful!)
bunkill --full-scan --dry-run

# Clean up specific framework projects
bunkill --dir ~/Projects --exclude .git .next .nuxt
```

#### CI/CD Integration
```bash
# Clean before build in CI
bunkill --dir . --depth 1 --delete-all

# Check disk usage before deployment
bunkill --dir /app --depth 2 > disk-usage.txt
```

### Common Patterns

#### Safe cleanup workflow
```bash
# 1. Dry run to see what would be deleted
bunkill --dir ~/Projects --dry-run

# 2. Review results
# 3. Run actual cleanup
bunkill --dir ~/Projects --delete-all
```

#### Regular maintenance script
```bash
#!/bin/bash
# cleanup.sh - Weekly node_modules cleanup

PROJECTS_DIR="$HOME/Projects"
LOG_FILE="$HOME/cleanup.log"

echo "Starting cleanup at $(date)" >> "$LOG_FILE"
bunkill --dir "$PROJECTS_DIR" --depth 2 --delete-all >> "$LOG_FILE" 2>&1
echo "Cleanup completed at $(date)" >> "$LOG_FILE"
```

## 🛠️ Development

### Project Structure
```
bunkill/
├── index.ts          # Main CLI application (TypeScript)
├── package.json      # Dependencies and build configuration
├── tsconfig.json     # TypeScript configuration
└── README.md         # Documentation
```

### Development Setup
```bash
# Clone and setup
git clone https://github.com/codingstark-dev/bunkill.git
cd bunkill

# Install dependencies
bun install

# Run in development mode
bun run index.ts --help

# Test with sample data
bun run index.ts --dir ./test-projects --dry-run
```

### Building for Distribution
```bash
# Development build with watch mode
bun build index.ts --outfile=bunkill-dev --watch

# Production build (optimized)
bun build index.ts --outfile=bunkill --target=bun --minify

# Cross-platform builds
bun build index.ts --outfile=bunkill-macos --target=bun --minify
bun build index.ts --outfile=bunkill-linux --target=bun --minify
bun build index.ts --outfile=bunkill-windows.exe --target=bun --minify
```

### Testing & Quality Assurance
```bash
# Test basic functionality
bun run index.ts --help

# Test scan functionality
bun run index.ts --depth 2

# Test interactive mode (dry run)
bun run index.ts --dry-run

# Test with specific directory
bun run index.ts --dir ~/Projects --exclude .git node_modules

# Performance testing
hyperfine "bun run index.ts --depth 3"
```

### Key Dependencies
- **Bun.js** - Runtime and package manager
- **Commander.js** - CLI argument parsing
- **Filesize.js** - Human-readable file sizes
- **TypeScript** - Type safety and development experience

### Code Architecture
- **Pure TypeScript** - No build step required for runtime
- **Modular design** - Easy to extend and maintain
- **Zero runtime dependencies** - Uses Bun.js built-ins wherever possible
- **Cross-platform support** - Handles platform differences gracefully

## 🐛 Troubleshooting

### Common Issues

#### Permission Errors
```bash
# Run with elevated permissions if needed
sudo bunkill

# Or fix directory permissions
sudo chown -R $(whoami) ~/Projects
```

#### Size Calculation Issues
- BunKill automatically falls back to manual calculation
- Check `du` command availability: `which du`
- Verify Bun.js installation: `bun --version`

#### Large Directories
- Interactive mode handles thousands of entries
- Use pagination to navigate efficiently
- Consider using `--depth` parameter to limit scan depth

### Debug Mode
```bash
# Enable verbose logging
DEBUG=1 bunkill --dir ~/Projects

# Check Bun.js version compatibility
bun --version
```

<!-- ## 📊 Benchmarks -->

### Performance Factors
- **Scan depth**: Deeper scans take longer
- **Directory count**: More directories = more time
- **Disk speed**: SSD vs HDD makes a difference
- **System load**: Background processes affect performance

## 🔧 Platform Support Status

### ✅ Currently Working Perfectly
- **macOS** - Fully tested and working perfectly

### 🔜 Next Priority
- **Linux** - Need testing and validation
- **Windows** - Need testing and validation

## 🤝 Contributing

We welcome contributions! Here's how to get started:

### Quick Start for Contributors
```bash
# Fork and clone your fork
git clone https://github.com/YOUR_USERNAME/bunkill.git
cd bunkill

# Install dependencies
bun install

# Create feature branch
git checkout -b feature/your-feature-name

# Make changes and test
bun run index.ts --help
bun run index.ts --dry-run --dir ~/test-projects

# Commit and push
git add .
git commit -m "feat: add your feature description"
git push origin feature/your-feature-name
```

### Contribution Guidelines
1. **Code Style**: Follow existing TypeScript patterns
2. **Testing**: Test with real directories before submitting
3. **Documentation**: Update README.md for new features
4. **Performance**: Ensure changes don't negatively impact speed
5. **Compatibility**: Test on Linux and Windows (next priority)

### Areas for Contribution
- **Performance improvements** - Faster scanning algorithms
- **UI enhancements** - Better interactive experience
- **Platform support** - Better Windows compatibility
- **New features** - Additional CLI options, export formats
- **Bug fixes** - Handle edge cases and error conditions

## 📄 License

MIT License - see [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- **Built with [Bun.js](https://bun.sh/)** - Incredible performance and TypeScript support
- **Inspired by [npkill](https://github.com/voidcosmos/npkill)** - Original node_modules cleanup concept
- **Powered by [Commander.js](https://github.com/tj/commander.js/)** - Professional CLI framework
- **Enhanced with [Filesize.js](https://github.com/avoidwork/filesize.js)** - Human-readable file sizes
- **Terminal styling** - Native ANSI color codes for maximum compatibility

---

**Made with ❤️ by the JavaScript community, for the JavaScript community**

> **Pro Tip**: Star ⭐ this repository if you find it useful, and share your cleanup stories in the issues!