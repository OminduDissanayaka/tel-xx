const TelegramBot = require('node-telegram-bot-api');
const fg = require('api-dylux');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { MongoClient } = require('mongodb');

// Bot configuration
const BOT_TOKEN = '8415938335:AAGgeow6Non1VkLYdC8fm9iq6YCGSlUZp8A';
const ADMIN_ID = "2034210940";
const MONGODB_URI = 'mongodb+srv://productionskod:AHH2AmFQbhWcXEks@cluster0.si2rf.mongodb.net/xvideo_bot';

// Initialize bot
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// MongoDB connection
let db;
let usersCollection;
let searchCacheCollection;

// Initialize MongoDB
async function initMongoDB() {
    try {
        const client = new MongoClient(MONGODB_URI);
        await client.connect();
        db = client.db();
        usersCollection = db.collection('users');
        searchCacheCollection = db.collection('search_cache');
        
        // Create indexes for better performance
        await usersCollection.createIndex({ userId: 1 }, { unique: true });
        await searchCacheCollection.createIndex({ userId: 1 });
        await searchCacheCollection.createIndex({ createdAt: 1 }, { expireAfterSeconds: 3600 }); // Expire after 1 hour
        
        console.log('✅ MongoDB connected successfully');
    } catch (error) {
        console.error('❌ MongoDB connection error:', error);
        process.exit(1);
    }
}

// User management functions
async function registerUser(userId, userInfo) {
    try {
        const user = {
            userId: userId,
            username: userInfo.username || null,
            firstName: userInfo.first_name || null,
            lastName: userInfo.last_name || null,
            isActivated: false,
            registeredAt: new Date(),
            lastActiveAt: new Date()
        };
        
        await usersCollection.updateOne(
            { userId: userId },
            { $setOnInsert: user, $set: { lastActiveAt: new Date() } },
            { upsert: true }
        );
        
        return user;
    } catch (error) {
        console.error('Error registering user:', error);
        return null;
    }
}

async function isUserActivated(userId) {
    if (userId === ADMIN_ID) return true;
    
    try {
        const user = await usersCollection.findOne({ userId: userId });
        return user && user.isActivated;
    } catch (error) {
        console.error('Error checking user activation:', error);
        return false;
    }
}

async function activateUser(userId) {
    try {
        await usersCollection.updateOne(
            { userId: userId },
            { $set: { isActivated: true, activatedAt: new Date() } }
        );
        return true;
    } catch (error) {
        console.error('Error activating user:', error);
        return false;
    }
}

async function deactivateUser(userId) {
    try {
        await usersCollection.updateOne(
            { userId: userId },
            { $set: { isActivated: false, deactivatedAt: new Date() } }
        );
        return true;
    } catch (error) {
        console.error('Error deactivating user:', error);
        return false;
    }
}

async function getAllUsers() {
    try {
        return await usersCollection.find({}).sort({ registeredAt: -1 }).toArray();
    } catch (error) {
        console.error('Error getting users:', error);
        return [];
    }
}

async function getActivatedUsers() {
    try {
        return await usersCollection.find({ isActivated: true }).toArray();
    } catch (error) {
        console.error('Error getting activated users:', error);
        return [];
    }
}

// Search cache functions
async function cacheSearchResults(userId, keyword, results) {
    try {
        await searchCacheCollection.updateOne(
            { userId: userId },
            {
                $set: {
                    userId: userId,
                    keyword: keyword,
                    results: results,
                    currentPage: 0,
                    createdAt: new Date()
                }
            },
            { upsert: true }
        );
    } catch (error) {
        console.error('Error caching search results:', error);
    }
}

async function getSearchResults(userId) {
    try {
        return await searchCacheCollection.findOne({ userId: userId });
    } catch (error) {
        console.error('Error getting search results:', error);
        return null;
    }
}

async function updateSearchPage(userId, page) {
    try {
        await searchCacheCollection.updateOne(
            { userId: userId },
            { $set: { currentPage: page } }
        );
    } catch (error) {
        console.error('Error updating search page:', error);
    }
}

// Utility functions
function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

async function downloadFile(url, filename) {
    try {
        const response = await axios({
            method: 'GET',
            url: url,
            responseType: 'stream',
            timeout: 300000 // 5 minutes timeout
        });
        
        const writer = fs.createWriteStream(filename);
        response.data.pipe(writer);
        
        return new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });
    } catch (error) {
        throw error;
    }
}

// Create pagination keyboard
function createPaginationKeyboard(searchData) {
    const { results, currentPage } = searchData;
    const keyboard = [];
    const buttonsPerRow = 1;
    const startIndex = currentPage * 10;
    const totalPages = Math.ceil(results.length / 10);
    
    // Video selection buttons (1 per row for better readability)
    for (let i = startIndex; i < Math.min(startIndex + 10, results.length); i++) {
        const video = results[i];
        const buttonText = `${i + 1}. ${video.title.substring(0, 40)}${video.title.length > 40 ? '...' : ''}`;
        keyboard.push([{
            text: buttonText,
            callback_data: `select_${i}`
        }]);
    }
    
    // Navigation buttons
    const navRow = [];
    if (currentPage > 0) {
        navRow.push({
            text: '⬅️ Previous',
            callback_data: `page_${currentPage - 1}`
        });
    }
    
    navRow.push({
        text: `📄 ${currentPage + 1}/${totalPages}`,
        callback_data: 'current_page'
    });
    
    if (currentPage < totalPages - 1) {
        navRow.push({
            text: 'Next ➡️',
            callback_data: `page_${currentPage + 1}`
        });
    }
    
    if (navRow.length > 0) keyboard.push(navRow);
    
    return { inline_keyboard: keyboard };
}

// Create user management keyboard
function createUserManagementKeyboard(users, page = 0) {
    const keyboard = [];
    const usersPerPage = 8;
    const startIndex = page * usersPerPage;
    const totalPages = Math.ceil(users.length / usersPerPage);
    
    // User buttons
    for (let i = startIndex; i < Math.min(startIndex + usersPerPage, users.length); i++) {
        const user = users[i];
        const status = user.isActivated ? '✅' : '❌';
        const name = user.firstName || user.username || `User ${user.userId}`;
        const buttonText = `${status} ${name} (${user.userId})`;
        
        keyboard.push([{
            text: buttonText,
            callback_data: `user_${user.userId}`
        }]);
    }
    
    // Navigation for users
    const navRow = [];
    if (page > 0) {
        navRow.push({
            text: '⬅️ Previous',
            callback_data: `users_page_${page - 1}`
        });
    }
    
    if (totalPages > 1) {
        navRow.push({
            text: `👥 ${page + 1}/${totalPages}`,
            callback_data: 'current_users_page'
        });
    }
    
    if (page < totalPages - 1) {
        navRow.push({
            text: 'Next ➡️',
            callback_data: `users_page_${page + 1}`
        });
    }
    
    if (navRow.length > 0) keyboard.push(navRow);
    
    return { inline_keyboard: keyboard };
}

// Bot command handlers

// Start command - Register user
bot.onText(/\/start/, async (msg) => {
    const userId = msg.from.id.toString();
    const userInfo = msg.from;
    
    // Register user in database
    await registerUser(userId, userInfo);
    
    const isActivated = await isUserActivated(userId);
    
    if (!isActivated) {
        bot.sendMessage(msg.chat.id, 
            "🤖 **Welcome to XVideo Bot!**\n\n" +
            "📝 Your account has been registered successfully!\n" +
            "⏳ Please wait for admin approval to start using the bot.\n\n" +
            "🚫 **Access Status:** Pending Activation\n\n" +
            "Contact admin for faster activation:",
            {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[
                        { text: "👨‍💻 Contact Admin", url: `tg://user?id=${ADMIN_ID}` }
                    ]]
                }
            }
        );
        
        // Notify admin about new registration
        bot.sendMessage(ADMIN_ID,
            `🔔 **New User Registration**\n\n` +
            `👤 Name: ${userInfo.first_name || 'Unknown'} ${userInfo.last_name || ''}\n` +
            `🆔 User ID: ${userId}\n` +
            `👨‍💻 Username: @${userInfo.username || 'No username'}\n\n` +
            `Use /users to manage users.`,
            { parse_mode: 'Markdown' }
        ).catch(() => console.log('Could not notify admin'));
        
        return;
    }
    
    const welcomeMessage = `
🎬 **Welcome to XVideo Bot!**

✅ **Account Status:** Activated

**Available Commands:**
🔍 /search <keyword> - Search for videos
📥 /download <link> - Download video from link
❓ /help - Show help message

${userId === ADMIN_ID ? `
**Admin Commands:**
👥 /users - Manage users
📢 /announce <message> - Send announcement
📊 /stats - Show statistics
` : ''}

Ready to search for videos! 🚀
    `;
    
    bot.sendMessage(msg.chat.id, welcomeMessage, { parse_mode: 'Markdown' });
});

// Users command (Admin only)
bot.onText(/\/users/, async (msg) => {
    const userId = msg.from.id.toString();
    
    if (userId !== ADMIN_ID) {
        bot.sendMessage(msg.chat.id, "🚫 Only admin can use this command.");
        return;
    }
    
    const users = await getAllUsers();
    
    if (users.length === 0) {
        bot.sendMessage(msg.chat.id, "📭 No users found.");
        return;
    }
    
    const keyboard = createUserManagementKeyboard(users, 0);
    
    const message = `
👥 **User Management**

Total Users: ${users.length}
Activated: ${users.filter(u => u.isActivated).length}
Pending: ${users.filter(u => !u.isActivated).length}

Select a user to activate/deactivate:
    `;
    
    bot.sendMessage(msg.chat.id, message, {
        parse_mode: 'Markdown',
        reply_markup: keyboard
    });
});

// Search command
bot.onText(/\/search (.+)/, async (msg, match) => {
    const userId = msg.from.id.toString();
    const keyword = match[1];
    
    if (!(await isUserActivated(userId))) {
        bot.sendMessage(msg.chat.id, "🚫 You don't have permission to use this bot.");
        return;
    }
    
    const searchingMsg = await bot.sendMessage(msg.chat.id, "🔍 Searching for videos...");
    
    try {
        const results = await fg.xvideosSearch(keyword);
        
        if (!results || results.length === 0) {
            bot.editMessageText("❌ No results found for your search.", {
                chat_id: msg.chat.id,
                message_id: searchingMsg.message_id
            });
            return;
        }
        
        // Cache search results
        await cacheSearchResults(userId, keyword, results);
        
        const totalPages = Math.ceil(results.length / 10);
        const searchData = { results, currentPage: 0 };
        const keyboard = createPaginationKeyboard(searchData);
        
        const resultMessage = `
🔍 **Search Results for:** "${keyword}"
📊 Found ${results.length} videos

📋 **Page 1 of ${totalPages}**
Select a video to view details:
        `;
        
        bot.editMessageText(resultMessage, {
            chat_id: msg.chat.id,
            message_id: searchingMsg.message_id,
            parse_mode: 'Markdown',
            reply_markup: keyboard
        });
        
    } catch (error) {
        console.error('Search error:', error);
        bot.editMessageText("❌ Error occurred while searching. Please try again later.", {
            chat_id: msg.chat.id,
            message_id: searchingMsg.message_id
        });
    }
});

// Download command
bot.onText(/\/download (.+)/, async (msg, match) => {
    const userId = msg.from.id.toString();
    const videoUrl = match[1];
    
    if (!(await isUserActivated(userId))) {
        bot.sendMessage(msg.chat.id, "🚫 You don't have permission to use this bot.");
        return;
    }
    
    const downloadingMsg = await bot.sendMessage(msg.chat.id, "📥 Processing download request...");
    
    try {
        const details = await fg.xvideosdl(videoUrl);
        
        if (!details || !details.url_dl) {
            bot.editMessageText("❌ Unable to process this link. Please check the URL.", {
                chat_id: msg.chat.id,
                message_id: downloadingMsg.message_id
            });
            return;
        }
        
        await processVideoDownload(msg.chat.id, downloadingMsg.message_id, details);
        
    } catch (error) {
        console.error('Download error:', error);
        bot.editMessageText("❌ Error occurred while downloading. Please try again later.", {
            chat_id: msg.chat.id,
            message_id: downloadingMsg.message_id
        });
    }
});

// Process video download
async function processVideoDownload(chatId, messageId, details) {
    try {
        const fileSize = details.sizeB || 0;
        const fileSizeMB = fileSize / (1024 * 1024);
        
        if (fileSizeMB > 200) {
            bot.editMessageText(
                `❌ **File Too Large**\n\nFile size: ${formatFileSize(fileSize)}\nMaximum allowed: 200MB`,
                {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: 'Markdown'
                }
            );
            return;
        }
        
        bot.editMessageText("⬇️ Downloading video file...", {
            chat_id: chatId,
            message_id: messageId
        });
        
        const filename = `video_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.mp4`;
        const filepath = path.join(__dirname, 'downloads', filename);
        
        // Create downloads directory if it doesn't exist
        const downloadsDir = path.join(__dirname, 'downloads');
        if (!fs.existsSync(downloadsDir)) {
            fs.mkdirSync(downloadsDir, { recursive: true });
        }
        
        await downloadFile(details.url_dl, filepath);
        
        bot.editMessageText("📤 Uploading to Telegram...", {
            chat_id: chatId,
            message_id: messageId
        });
        
        const caption = `
🎬 **${details.title}**
👀 ${details.views || 'N/A'}
📊 ${details.vote || 'N/A'}
📁 ${details.size || formatFileSize(fileSize)}
        `;
        
        if (fileSizeMB <= 100) {
            await bot.sendVideo(chatId, filepath, {
                caption: caption,
                parse_mode: 'Markdown'
            });
        } else {
            await bot.sendDocument(chatId, filepath, {
                caption: caption,
                parse_mode: 'Markdown'
            });
        }
        
        // Clean up file
        fs.unlinkSync(filepath);
        bot.deleteMessage(chatId, messageId).catch(() => {});
        
    } catch (error) {
        console.error('Download processing error:', error);
        bot.editMessageText("❌ Error during download process. Please try again.", {
            chat_id: chatId,
            message_id: messageId
        });
    }
}

// Help command
bot.onText(/\/help/, async (msg) => {
    const userId = msg.from.id.toString();
    
    if (!(await isUserActivated(userId))) {
        bot.sendMessage(msg.chat.id, "🚫 You don't have permission to use this bot.");
        return;
    }
    
    const helpMessage = `
📖 **XVideo Bot Help**

**🔍 Search Videos:**
\`/search <keyword>\` - Search for videos
Example: \`/search romantic\`

**📥 Download Videos:**
\`/download <link>\` - Download from direct link
Example: \`/download https://example.com/video\`

**📋 How to Use:**
1. Search using keywords
2. Browse results with navigation buttons
3. Select a video to see details
4. Click "📥 Download" to get the video
5. Files ≤100MB sent as video, >100MB as document

**⚠️ Limitations:**
• Maximum file size: 200MB
• Search results expire after 1 hour
• One download at a time per user

Need help? Contact admin! 👨‍💻
    `;
    
    bot.sendMessage(msg.chat.id, helpMessage, { parse_mode: 'Markdown' });
});

// Stats command (Admin only)
bot.onText(/\/stats/, async (msg) => {
    const userId = msg.from.id.toString();
    
    if (userId !== ADMIN_ID) {
        bot.sendMessage(msg.chat.id, "🚫 Only admin can use this command.");
        return;
    }
    
    try {
        const totalUsers = await usersCollection.countDocuments({});
        const activatedUsers = await usersCollection.countDocuments({ isActivated: true });
        const pendingUsers = totalUsers - activatedUsers;
        const recentUsers = await usersCollection.countDocuments({
            registeredAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
        });
        
        const statsMessage = `
📊 **Bot Statistics**

👥 **Users:**
• Total: ${totalUsers}
• Activated: ${activatedUsers}
• Pending: ${pendingUsers}
• New (24h): ${recentUsers}

💾 **System:**
• Memory: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB
• Uptime: ${Math.round(process.uptime() / 3600)}h
        `;
        
        bot.sendMessage(msg.chat.id, statsMessage, { parse_mode: 'Markdown' });
        
    } catch (error) {
        console.error('Stats error:', error);
        bot.sendMessage(msg.chat.id, "❌ Error retrieving statistics.");
    }
});

// Announce command (Admin only)
bot.onText(/\/announce (.+)/, async (msg, match) => {
    const userId = msg.from.id.toString();
    const announcement = match[1];
    
    if (userId !== ADMIN_ID) {
        bot.sendMessage(msg.chat.id, "🚫 Only admin can use this command.");
        return;
    }
    
    const statusMsg = await bot.sendMessage(msg.chat.id, "📤 Sending announcement...");
    
    try {
        const activatedUsers = await getActivatedUsers();
        const message = `📢 **Announcement**\n\n${announcement}`;
        
        let sentCount = 0;
        let errorCount = 0;
        
        for (const user of activatedUsers) {
            try {
                await bot.sendMessage(user.userId, message, { parse_mode: 'Markdown' });
                sentCount++;
                // Small delay to avoid rate limiting
                await new Promise(resolve => setTimeout(resolve, 100));
            } catch (error) {
                errorCount++;
            }
        }
        
        bot.editMessageText(
            `📊 **Announcement Results**\n\n✅ Delivered: ${sentCount}\n❌ Failed: ${errorCount}`,
            {
                chat_id: msg.chat.id,
                message_id: statusMsg.message_id,
                parse_mode: 'Markdown'
            }
        );
        
    } catch (error) {
        console.error('Announce error:', error);
        bot.editMessageText("❌ Error sending announcement.", {
            chat_id: msg.chat.id,
            message_id: statusMsg.message_id
        });
    }
});

// Callback query handler
bot.on('callback_query', async (query) => {
    const userId = query.from.id.toString();
    const data = query.data;
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    
    try {
        if (data.startsWith('page_')) {
            // Handle search pagination
            if (!(await isUserActivated(userId))) {
                bot.answerCallbackQuery(query.id, { text: "Access denied." });
                return;
            }
            
            const pageNum = parseInt(data.split('_')[1]);
            const searchData = await getSearchResults(userId);
            
            if (!searchData || !searchData.results) {
                bot.answerCallbackQuery(query.id, { text: "Search expired. Please search again." });
                return;
            }
            
            await updateSearchPage(userId, pageNum);
            searchData.currentPage = pageNum;
            
            const totalPages = Math.ceil(searchData.results.length / 10);
            const keyboard = createPaginationKeyboard(searchData);
            
            const resultMessage = `
🔍 **Search Results for:** "${searchData.keyword}"
📊 Found ${searchData.results.length} videos

📋 **Page ${pageNum + 1} of ${totalPages}**
Select a video to view details:
            `;
            
            bot.editMessageText(resultMessage, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown',
                reply_markup: keyboard
            });
            
            bot.answerCallbackQuery(query.id);
            
        } else if (data.startsWith('select_')) {
            // Handle video selection
            const videoIndex = parseInt(data.split('_')[1]);
            const searchData = await getSearchResults(userId);
            
            if (!searchData || !searchData.results || !searchData.results[videoIndex]) {
                bot.answerCallbackQuery(query.id, { text: "Video not found." });
                return;
            }
            
            const video = searchData.results[videoIndex];
            
            bot.editMessageText("🔄 Loading video details...", {
                chat_id: chatId,
                message_id: messageId
            });
            
            try {
                const details = await fg.xvideosdl(video.url);
                
                const fileSize = details.sizeB || 0;
                const fileSizeMB = fileSize / (1024 * 1024);
                const sizeWarning = fileSizeMB > 200 ? "\n⚠️ **File too large (>200MB)**" : "";
                
                const detailMessage = `
🎬 **${details.title || video.title}**

⏱️ **Duration:** ${video.duration}
👀 **Views:** ${details.views || 'N/A'}
📊 **Rating:** ${details.vote || 'N/A'} (👍 ${details.likes || 'N/A'} | 👎 ${details.dislikes || 'N/A'})
📁 **Size:** ${details.size || formatFileSize(fileSize)}${sizeWarning}

🔗 **Source:** [View Original](${video.url})

${fileSizeMB <= 200 ? 'Click Download to get this video! 📥' : 'File is too large to download.'}
                `;
                
                const detailKeyboard = {
                    inline_keyboard: [
                        ...(fileSizeMB <= 200 ? [[{
                            text: "📥 Download Video",
                            callback_data: `download_${videoIndex}`
                        }]] : []),
                        [{
                            text: "⬅️ Back to Results",
                            callback_data: "back_to_results"
                        }]
                    ]
                };
                
                bot.editMessageText(detailMessage, {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: 'Markdown',
                    reply_markup: detailKeyboard,
                    disable_web_page_preview: true
                });
                
            } catch (error) {
                console.error('Video details error:', error);
                bot.editMessageText("❌ Error loading video details. Please try another video.", {
                    chat_id: chatId,
                    message_id: messageId
                });
            }
            
            bot.answerCallbackQuery(query.id);
            
        } else if (data.startsWith('download_')) {
            // Handle video download
            const videoIndex = parseInt(data.split('_')[1]);
            const searchData = await getSearchResults(userId);
            
            if (!searchData || !searchData.results || !searchData.results[videoIndex]) {
                bot.answerCallbackQuery(query.id, { text: "Video not found." });
                return;
            }
            
            const video = searchData.results[videoIndex];
            
            bot.editMessageText("📥 Preparing download...", {
                chat_id: chatId,
                message_id: messageId
            });
            
            try {
                const details = await fg.xvideosdl(video.url);
                if (details && details.url_dl) {
                    await processVideoDownload(chatId, messageId, details);
                } else {
                    bot.editMessageText("❌ Unable to download this video.", {
                        chat_id: chatId,
                        message_id: messageId
                    });
                }
            } catch (error) {
                console.error('Download error:', error);
                bot.editMessageText("❌ Download failed. Please try again.", {
                    chat_id: chatId,
                    message_id: messageId
                });
            }
            
            bot.answerCallbackQuery(query.id);
            
        } else if (data === 'back_to_results') {
            // Handle back to results
            const searchData = await getSearchResults(userId);
            
            if (!searchData || !searchData.results) {
                bot.answerCallbackQuery(query.id, { text: "Search expired." });
                return;
            }
            
            const totalPages = Math.ceil(searchData.results.length / 10);
            const keyboard = createPaginationKeyboard(searchData);
            
            const resultMessage = `
🔍 **Search Results for:** "${searchData.keyword}"
📊 Found ${searchData.results.length} videos

📋 **Page ${searchData.currentPage + 1} of ${totalPages}**
Select a video to view details:
            `;
            
            bot.editMessageText(resultMessage, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown',
                reply_markup: keyboard
            });
            
            bot.answerCallbackQuery(query.id);
            
        } else if (data.startsWith('user_')) {
            // Handle user selection (Admin only)
            if (userId !== ADMIN_ID) {
                bot.answerCallbackQuery(query.id, { text: "Admin only." });
                return;
            }
            
            const targetUserId = data.split('_')[1];
            const user = await usersCollection.findOne({ userId: targetUserId });
            
            if (!user) {
                bot.answerCallbackQuery(query.id, { text: "User not found." });
                return;
            }
            
            const userName = user.firstName || user.username || `User ${user.userId}`;
            const status = user.isActivated ? "Activated ✅" : "Not Activated ❌";
            
            const userMessage = `
👤 **User Details**

**Name:** ${userName}
**User ID:** ${user.userId}
**Username:** @${user.username || 'No username'}
**Status:** ${status}
**Registered:** ${user.registeredAt.toLocaleString()}
**Last Active:** ${user.lastActiveAt.toLocaleString()}

Choose an action:
            `;
            
            const userKeyboard = {
                inline_keyboard: [
                    [{
                        text: user.isActivated ? "🚫 Deactivate" : "✅ Activate",
                        callback_data: user.isActivated ? `deactivate_${targetUserId}` : `activate_${targetUserId}`
                    }],
                    [{
                        text: "⬅️ Back to Users",
                        callback_data: "back_to_users"
                    }]
                ]
            };
            
            bot.editMessageText(userMessage, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown',
                reply_markup: userKeyboard
            });
            
            bot.answerCallbackQuery(query.id);
            
        } else if (data.startsWith('activate_') || data.startsWith('deactivate_')) {
            // Handle user activation/deactivation (Admin only)
            if (userId !== ADMIN_ID) {
                bot.answerCallbackQuery(query.id, { text: "Admin only." });
                return;
            }
            
            const isActivating = data.startsWith('activate_');
            const targetUserId = data.split('_')[1];
            
            try {
                let success;
                if (isActivating) {
                    success = await activateUser(targetUserId);
                } else {
                    success = await deactivateUser(targetUserId);
                }
                
                if (success) {
                    const action = isActivating ? "activated" : "deactivated";
                    const emoji = isActivating ? "✅" : "❌";
                    
                    bot.answerCallbackQuery(query.id, { 
                        text: `User ${action} successfully!`,
                        show_alert: true 
                    });
                    
                    // Notify the target user
                    const notificationMessage = isActivating 
                        ? "🎉 **Account Activated!**\n\nYour account has been activated! You can now use all bot features.\n\nUse /start to begin!"
                        : "⚠️ **Access Revoked**\n\nYour access to this bot has been revoked by the administrator.";
                    
                    bot.sendMessage(targetUserId, notificationMessage, { parse_mode: 'Markdown' })
                        .catch(() => console.log(`Could not notify user ${targetUserId}`));
                    
                    // Update the message to show new status
                    const user = await usersCollection.findOne({ userId: targetUserId });
                    const userName = user.firstName || user.username || `User ${user.userId}`;
                    const status = user.isActivated ? "Activated ✅" : "Not Activated ❌";
                    
                    const updatedMessage = `
👤 **User Details**

**Name:** ${userName}
**User ID:** ${user.userId}
**Username:** @${user.username || 'No username'}
**Status:** ${status}
**Registered:** ${user.registeredAt.toLocaleString()}
**Last Active:** ${user.lastActiveAt.toLocaleString()}

${isActivating ? '✅ User activated successfully!' : '❌ User deactivated successfully!'}

Choose an action:
                    `;
                    
                    const updatedKeyboard = {
                        inline_keyboard: [
                            [{
                                text: user.isActivated ? "🚫 Deactivate" : "✅ Activate",
                                callback_data: user.isActivated ? `deactivate_${targetUserId}` : `activate_${targetUserId}`
                            }],
                            [{
                                text: "⬅️ Back to Users",
                                callback_data: "back_to_users"
                            }]
                        ]
                    };
                    
                    bot.editMessageText(updatedMessage, {
                        chat_id: chatId,
                        message_id: messageId,
                        parse_mode: 'Markdown',
                        reply_markup: updatedKeyboard
                    });
                    
                } else {
                    bot.answerCallbackQuery(query.id, { 
                        text: "Operation failed. Please try again.",
                        show_alert: true 
                    });
                }
                
            } catch (error) {
                console.error('User management error:', error);
                bot.answerCallbackQuery(query.id, { 
                    text: "Error occurred. Please try again.",
                    show_alert: true 
                });
            }
            
        } else if (data.startsWith('users_page_')) {
            // Handle user list pagination (Admin only)
            if (userId !== ADMIN_ID) {
                bot.answerCallbackQuery(query.id, { text: "Admin only." });
                return;
            }
            
            const page = parseInt(data.split('_')[2]);
            const users = await getAllUsers();
            const keyboard = createUserManagementKeyboard(users, page);
            
            const message = `
👥 **User Management**

Total Users: ${users.length}
Activated: ${users.filter(u => u.isActivated).length}
Pending: ${users.filter(u => !u.isActivated).length}

Select a user to activate/deactivate:
            `;
            
            bot.editMessageText(message, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown',
                reply_markup: keyboard
            });
            
            bot.answerCallbackQuery(query.id);
            
        } else if (data === 'back_to_users') {
            // Handle back to users list (Admin only)
            if (userId !== ADMIN_ID) {
                bot.answerCallbackQuery(query.id, { text: "Admin only." });
                return;
            }
            
            const users = await getAllUsers();
            const keyboard = createUserManagementKeyboard(users, 0);
            
            const message = `
👥 **User Management**

Total Users: ${users.length}
Activated: ${users.filter(u => u.isActivated).length}
Pending: ${users.filter(u => !u.isActivated).length}

Select a user to activate/deactivate:
            `;
            
            bot.editMessageText(message, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown',
                reply_markup: keyboard
            });
            
            bot.answerCallbackQuery(query.id);
            
        } else if (data === 'current_page' || data === 'current_users_page') {
            bot.answerCallbackQuery(query.id, { text: "You are on this page." });
        }
        
    } catch (error) {
        console.error('Callback query error:', error);
        bot.answerCallbackQuery(query.id, { text: "An error occurred. Please try again." });
    }
});

// Handle unauthorized access
bot.on('message', async (msg) => {
    const userId = msg.from.id.toString();
    
    // Skip if it's a command that was already handled
    if (msg.text && msg.text.startsWith('/')) return;
    
    // Check if user is registered and activated
    const isActivated = await isUserActivated(userId);
    
    if (!isActivated) {
        // Check if user is registered
        const user = await usersCollection.findOne({ userId: userId });
        
        if (!user) {
            // User not registered
            bot.sendMessage(msg.chat.id,
                "🤖 **Welcome!**\n\n" +
                "Please use /start to register and get access to the bot.",
                { parse_mode: 'Markdown' }
            );
        } else {
            // User registered but not activated
            bot.sendMessage(msg.chat.id,
                "⏳ **Waiting for Activation**\n\n" +
                "Your account is registered but waiting for admin approval.\n" +
                "Please contact the administrator for activation.",
                {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [[
                            { text: "👨‍💻 Contact Admin", url: `tg://user?id=${ADMIN_ID}` }
                        ]]
                    }
                }
            );
        }
    }
});

// Error handling
bot.on('error', (error) => {
    console.error('Bot error:', error);
});

bot.on('polling_error', (error) => {
    console.error('Polling error:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('Received SIGINT. Graceful shutdown...');
    bot.stopPolling();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('Received SIGTERM. Graceful shutdown...');
    bot.stopPolling();
    process.exit(0);
});

// Initialize and start bot
async function startBot() {
    try {
        await initMongoDB();
        console.log('🤖 XVideo Bot is running...');
        console.log(`👨‍💻 Admin ID: ${ADMIN_ID}`);
        
        // Get initial user count
        const totalUsers = await usersCollection.countDocuments({});
        const activatedUsers = await usersCollection.countDocuments({ isActivated: true });
        console.log(`👥 Total users: ${totalUsers} (${activatedUsers} activated)`);
        
    } catch (error) {
        console.error('Failed to start bot:', error);
        process.exit(1);
    }
}

startBot();