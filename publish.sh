#!/bin/bash

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}🚀 Publishing MCP Server Kubernetes to npm...${NC}"

# Check if we're logged in to npm
if ! npm whoami > /dev/null 2>&1; then
    echo -e "${RED}❌ You're not logged in to npm. Please run: npm login${NC}"
    exit 1
fi

echo -e "${GREEN}✅ Logged in to npm as: $(npm whoami)${NC}"

# Check if git working directory is clean
if [[ -n $(git status --porcelain) ]]; then
    echo -e "${YELLOW}⚠️  Warning: You have uncommitted changes${NC}"
    read -p "Do you want to continue? (y/N): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo -e "${RED}❌ Aborted${NC}"
        exit 1
    fi
fi

# Show current version
CURRENT_VERSION=$(node -p "require('./package.json').version")
echo -e "${BLUE}📦 Current version: ${CURRENT_VERSION}${NC}"

# Ask for version bump type
echo -e "${YELLOW}Select version bump type:${NC}"
echo "1) patch (bug fixes) - e.g., 2.3.1 → 2.3.2"
echo "2) minor (new features) - e.g., 2.3.1 → 2.4.0"
echo "3) major (breaking changes) - e.g., 2.3.1 → 3.0.0"
echo "4) custom version"
echo "5) no version change (republish current)"

read -p "Enter choice (1-5): " choice

case $choice in
    1)
        echo -e "${BLUE}🔧 Bumping patch version...${NC}"
        npm version patch
        ;;
    2)
        echo -e "${BLUE}🔧 Bumping minor version...${NC}"
        npm version minor
        ;;
    3)
        echo -e "${BLUE}🔧 Bumping major version...${NC}"
        npm version major
        ;;
    4)
        read -p "Enter custom version (e.g., 2.4.0-beta.1): " custom_version
        echo -e "${BLUE}🔧 Setting version to ${custom_version}...${NC}"
        npm version $custom_version
        ;;
    5)
        echo -e "${BLUE}📦 Using current version: ${CURRENT_VERSION}${NC}"
        ;;
    *)
        echo -e "${RED}❌ Invalid choice${NC}"
        exit 1
        ;;
esac

# Build the project
echo -e "${BLUE}🔨 Building project...${NC}"
npm run build

if [ $? -ne 0 ]; then
    echo -e "${RED}❌ Build failed${NC}"
    exit 1
fi

echo -e "${GREEN}✅ Build successful${NC}"

# Show what will be published
echo -e "${BLUE}📋 Files that will be published:${NC}"
npm pack --dry-run

# Confirm publication
NEW_VERSION=$(node -p "require('./package.json').version")
echo -e "${YELLOW}📦 Ready to publish version ${NEW_VERSION}${NC}"
read -p "Proceed with publication? (y/N): " -n 1 -r
echo

if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo -e "${RED}❌ Publication cancelled${NC}"
    exit 1
fi

# Publish to npm
echo -e "${BLUE}🚀 Publishing to npm...${NC}"
npm publish --access public

if [ $? -eq 0 ]; then
    echo -e "${GREEN}✅ Successfully published @raihan0824/mcp-server-kubernetes@${NEW_VERSION}${NC}"
    echo -e "${GREEN}🎉 You can now use it with:${NC}"
    echo -e "${BLUE}   npx @raihan0824/mcp-server-kubernetes${NC}"
    
    # Push git tags if version was bumped
    if [ "$choice" != "5" ]; then
        echo -e "${BLUE}📤 Pushing git tags...${NC}"
        git push origin --tags
    fi
else
    echo -e "${RED}❌ Publication failed${NC}"
    exit 1
fi 