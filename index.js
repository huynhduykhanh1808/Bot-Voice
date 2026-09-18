require("dotenv").config();
const {
    Client,
    GatewayIntentBits,
    Partials,
    REST,
    Routes,
    SlashCommandBuilder,
    PermissionFlagsBits,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle
} = require("discord.js");
const {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    VoiceConnectionStatus
} = require("@discordjs/voice");
const sqlite3 = require("sqlite3").verbose();
const express = require("express");
const fs = require("fs");
const path = require("path");
const gTTS = require("gtts");

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
if (!TOKEN) {
    console.error("❌ Chưa có DISCORD_TOKEN trong môi trường!");
    process.exit(1);
}

// Web Server chống sleep trên Render
const app = express();
app.get("/", (req, res) => res.send("Voice & AI Bot is alive!"));
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🌐 Web server đã chạy trên cổng ${PORT}`));

// SQLite Database
const DB_FILE = process.env.DB_PATH || "tempvoice.db";
const db = new sqlite3.Database(DB_FILE, (err) => {
    if (err) console.error("Lỗi kết nối SQLite:", err.message);
    else console.log("📦 Đã kết nối cơ sở dữ liệu SQLite thành công.");
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS generators (
        guild_id TEXT PRIMARY KEY,
        category_id TEXT NOT NULL,
        generator_id TEXT NOT NULL,
        blog_channel_id TEXT,
        tracked_text_channel_id TEXT
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS rooms (
        guild_id TEXT NOT NULL,
        channel_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        category_id TEXT NOT NULL
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS bot_settings (
        guild_id TEXT PRIMARY KEY,
        tts_enabled INTEGER DEFAULT 1,
        volume INTEGER DEFAULT 100
    )`);
});

const getGenerator = (guildId) => new Promise((resolve) => {
    db.get("SELECT * FROM generators WHERE guild_id = ?", [guildId], (err, row) => resolve(row));
});

const saveGenerator = (guildId, categoryId, generatorId, blogChannelId, trackedChannelId = null) => {
    db.run(`INSERT INTO generators(guild_id, category_id, generator_id, blog_channel_id, tracked_text_channel_id)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(guild_id) DO UPDATE SET
            category_id=excluded.category_id,
            generator_id=excluded.generator_id,
            blog_channel_id=COALESCE(excluded.blog_channel_id, blog_channel_id),
            tracked_text_channel_id=COALESCE(excluded.tracked_text_channel_id, tracked_text_channel_id)`,
        [guildId, categoryId, generatorId, blogChannelId, trackedChannelId]
    );
};

const updateTrackedChannel = (guildId, channelId) => {
    db.run("UPDATE generators SET tracked_text_channel_id = ? WHERE guild_id = ?", [channelId, guildId]);
};

const clearTrackedChannel = (guildId) => {
    db.run("UPDATE generators SET tracked_text_channel_id = NULL WHERE guild_id = ?", [guildId]);
};

const saveRoom = (guildId, channelId, ownerId, categoryId) => {
    db.run("INSERT OR REPLACE INTO rooms(guild_id, channel_id, owner_id, category_id) VALUES (?, ?, ?, ?)",
        [guildId, channelId, ownerId, categoryId]
    );
};

const getRoom = (channelId) => new Promise((resolve) => {
    db.get("SELECT * FROM rooms WHERE channel_id = ?", [channelId], (err, row) => resolve(row));
});

const getOwnedRoom = (guildId, ownerId) => new Promise((resolve) => {
    db.get("SELECT * FROM rooms WHERE guild_id = ? AND owner_id = ?", [guildId, ownerId], (err, row) => resolve(row));
});

const deleteRoomRecord = (channelId) => {
    db.run("DELETE FROM rooms WHERE channel_id = ?", [channelId]);
};

const getBotSettings = (guildId) => new Promise((resolve) => {
    db.get("SELECT * FROM bot_settings WHERE guild_id = ?", [guildId], (err, row) => {
        resolve(row || { tts_enabled: 1, volume: 100 });
    });
});

const updateBotSettings = (guildId, ttsEnabled, volume) => {
    db.run(`INSERT INTO bot_settings(guild_id, tts_enabled, volume) VALUES (?, ?, ?)
        ON CONFLICT(guild_id) DO UPDATE SET 
        tts_enabled = COALESCE(?, tts_enabled), 
        volume = COALESCE(?, volume)`,
        [guildId, ttsEnabled, volume, ttsEnabled, volume]
    );
};

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ],
    partials: [Partials.Channel, Partials.Message, Partials.GuildMember]
});

const activeVoiceBots = new Map();

async function sendBlogLog(guild, tag, content) {
    try {
        const gen = await getGenerator(guild.id);
        if (gen && gen.blog_channel_id) {
            const blogCh = guild.channels.cache.get(gen.blog_channel_id);
            if (blogCh) {
                const timestamp = Math.floor(Date.now() / 1000);
                const cleanContent = content.replace(/\n/g, " ");
                await blogCh.send(`\`[${tag}]\` <t:${timestamp}:t> -${cleanContent}`);
            }
        }
    } catch (e) {
        console.error("Lỗi gửi blog log:", e);
    }
}

class LimitModal extends ModalBuilder {
    constructor() {
        super();
        this.setTitle("⚙️ Giới hạn số lượng thành viên").setCustomId("modal_limit");
        const limitInput = new TextInputBuilder()
            .setCustomId("limit_val")
            .setLabel("Số lượng tối đa (0 = Không giới hạn)")
            .setPlaceholder("Nhập số từ 1 đến 99...")
            .setMinLength(1)
            .setMaxLength(2)
            .setRequired(true)
            .setStyle(TextInputStyle.Short);
        this.addComponents(new ActionRowBuilder().addComponents(limitInput));
    }
}

class RenameModal extends ModalBuilder {
    constructor() {
        super();
        this.setTitle("✏️ Đổi tên phòng thoại").setCustomId("modal_rename");
        const nameInput = new TextInputBuilder()
            .setCustomId("name_val")
            .setLabel("Tên phòng mới")
            .setPlaceholder("Nhập tên phòng mới...")
            .setMinLength(1)
            .setMaxLength(100)
            .setRequired(true)
            .setStyle(TextInputStyle.Short);
        this.addComponents(new ActionRowBuilder().addComponents(nameInput));
    }
}

class TransferModal extends ModalBuilder {
    constructor() {
        super();
        this.setTitle("👑 Chuyển quyền chủ phòng").setCustomId("modal_transfer");
        const uidInput = new TextInputBuilder()
            .setCustomId("uid_val")
            .setLabel("ID Discord thành viên nhận quyền")
            .setPlaceholder("Ví dụ: 123456789012345678")
            .setMaxLength(20)
            .setRequired(true)
            .setStyle(TextInputStyle.Short);
        this.addComponents(new ActionRowBuilder().addComponents(uidInput));
    }
}

function getVoiceControlRows(ttsEnabled = true) {
    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("vc_lock").setLabel("Khóa").setStyle(ButtonStyle.Secondary).setEmoji("🔒"),
        new ButtonBuilder().setCustomId("vc_unlock").setLabel("Mở khóa").setStyle(ButtonStyle.Secondary).setEmoji("🔓"),
        new ButtonBuilder().setCustomId("vc_hide").setLabel("Ẩn").setStyle(ButtonStyle.Secondary).setEmoji("🥷"),
        new ButtonBuilder().setCustomId("vc_unhide").setLabel("Hiện").setStyle(ButtonStyle.Secondary).setEmoji("👁️")
    );

    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("vc_limit").setLabel("Giới hạn").setStyle(ButtonStyle.Secondary).setEmoji("👥"),
        new ButtonBuilder().setCustomId("vc_rename").setLabel("Đổi tên").setStyle(ButtonStyle.Secondary).setEmoji("✏️"),
        new ButtonBuilder().setCustomId("vc_region").setLabel("Khu vực").setStyle(ButtonStyle.Secondary).setEmoji("🌐"),
        new ButtonBuilder().setCustomId("vc_reset").setLabel("Reset").setStyle(ButtonStyle.Secondary).setEmoji("🔄")
    );

    const row3 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("vc_claim").setLabel("Nhận chủ").setStyle(ButtonStyle.Secondary).setEmoji("👑"),
        new ButtonBuilder().setCustomId("vc_transfer").setLabel("Chuyển chủ").setStyle(ButtonStyle.Secondary).setEmoji("📤"),
        new ButtonBuilder().setCustomId("tts_toggle").setLabel(ttsEnabled ? "Tắt tiếng Bot" : "Bật tiếng Bot").setStyle(ttsEnabled ? ButtonStyle.Success : ButtonStyle.Danger).setEmoji(ttsEnabled ? "🔊" : "🔇"),
        new ButtonBuilder().setCustomId("tts_vol_down").setLabel("Giảm Âm Lượng").setStyle(ButtonStyle.Secondary).setEmoji("🔉")
    );

    const row4 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("tts_vol_up").setLabel("Tăng Âm Lượng").setStyle(ButtonStyle.Secondary).setEmoji("🔊")
    );

    return [row1, row2, row3, row4];
}

async function handleAIQuery(message) {
    const text = message.content.toLowerCase();
    const guild = message.guild;

    if (text.includes("chủ server") || text.includes("admin") || text.includes("ai là chủ")) {
        const owner = await guild.fetchOwner();
        return message.reply(`👑 Chủ sở hữu của server **${guild.name}** là **${owner.user.tag}** (ID:${owner.id}). Bạn có thể liên hệ trực tiếp qua tin nhắn trực tiếp nếu cần hỗ trợ nhé!`);
    }

    if (text.includes("liên lạc") || text.includes("liên hệ") || text.includes("hỗ trợ")) {
        const owner = await guild.fetchOwner();
        return message.reply(`📞 Để liên lạc với ban quản trị hoặc chủ server (${owner.user.tag}), bạn có thể tạo vé hỗ trợ (ticket) hoặc nhắn trực tiếp cho Admin trong server.`);
    }

    if (text.includes("luật") || text.includes("quy định") || text.includes("rule")) {
        const ruleChannel = guild.channels.cache.find(c => c.name.includes("luật") || c.name.includes("rules"));
        if (ruleChannel) {
            return message.reply(`📜 Bạn có thể xem toàn bộ nội quy và quy định của server tại kênh ${ruleChannel.mention}. Hãy đọc kỹ để tránh vi phạm nhé!`);
        }
        return message.reply(`📜 Server luôn đề cao sự tôn trọng lẫn nhau, không spam, không toxic và tuân thủ các quy định chung của Discord.`);
    }

    if (text.includes("tải phần mềm") || text.includes("download") || text.includes("phần mềm ở đâu")) {
        return message.reply(`💾 Các phần mềm, công cụ và tài nguyên hữu ích thường được ghim hoặc chia sẻ tại các kênh thông tin / chia sẻ tài nguyên trong server. Bạn hãy kiểm tra phần Ghim của kênh hoặc hỏi trực tiếp mọi người nhé!`);
    }

    if (text.includes(client.user.username.toLowerCase()) || text.includes("bot ơi") || text.includes("ê bot")) {
        const jokes = [
            "Hí lô bạn! Mình đây, bot thông minh nhất server luôn phục vụ bạn nè! 😎",
            "Ai gọi trẫm đấy? Có chuyện gì cần trợ giúp hoặc trò chuyện cứ nói mình nhé!",
            "Mình đang trực sẵn sàng trong các phòng thoại để đọc tin nhắn và hỗ trợ mọi người đây! 🤖✨",
            "Đừng khen mình ngại nha, muốn hỏi luật hay tìm chủ server cứ hỏi mình!"
        ];
        return message.reply(jokes[Math.floor(Math.random() * jokes.length)]);
    }
}

async function speakTextInChannel(channel, text) {
    try {
        const settings = await getBotSettings(channel.guild.id);
        if (!settings.tts_enabled) return;

        let voiceBotData = activeVoiceBots.get(channel.id);
        if (!voiceBotData) {
            const connection = joinVoiceChannel({
                channelId: channel.id,
                guildId: channel.guild.id,
                adapterCreator: channel.guild.voiceAdapterCreator,
                selfDeaf: false,
                selfMute: false
            });

            const player = createAudioPlayer();
            connection.subscribe(player);

            voiceBotData = { connection, player, volume: settings.volume / 100 };
            activeVoiceBots.set(channel.id, voiceBotData);

            connection.on(VoiceConnectionStatus.Disconnected, () => {
                try { connection.destroy(); } catch (e) {}
                activeVoiceBots.delete(channel.id);
            });
        }

        const cleanText = text.replace(/<@!?\d+>/g, "thành viên").substring(0, 200);
        const speech = new gTTS(cleanText, 'vi');
        const filePath = path.join(__dirname, `tts_${channel.id}_${Date.now()}.mp3`);

        speech.save(filePath, async function (err) {
            if (err) return;
            try {
                const resource = createAudioResource(filePath, { inlineVolume: true });
                resource.volume.setVolume(voiceBotData.volume || 1.0);
                voiceBotData.player.play(resource);
                voiceBotData.player.once(AudioPlayerStatus.Idle, () => {
                    fs.unlink(filePath, () => {});
                });
            } catch (e) {
                fs.unlink(filePath, () => {});
            }
        });
    } catch (e) {
        console.error("Lỗi TTS:", e);
    }
}

client.once("ready", async () => {
    console.log(`🤖 Đã đăng nhập thành công bot: ${client.user.tag}`);
    client.user.setActivity("Voice chat & AI Assistant", { type: 3 });

    const commands = [
        new SlashCommandBuilder()
            .setName("setup")
            .setDescription("[Quản trị viên] Khởi tạo hệ thống phòng thoại tự động và kênh blog")
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
        new SlashCommandBuilder()
            .setName("track-channel")
            .setDescription("[Quản trị viên] Gán kênh chat hiện tại để bot theo dõi thời gian thực vào blog")
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
        new SlashCommandBuilder()
            .setName("untrack-channel")
            .setDescription("[Quản trị viên] Hủy theo dõi kênh chat thời gian thực")
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
        new SlashCommandBuilder()
            .setName("room-allow")
            .setDescription("[Chủ phòng] Cho phép thành viên tham gia phòng thoại của bạn")
            .addUserOption(option => option.setName("user").setDescription("Thành viên cần cấp quyền").setRequired(true)),
        new SlashCommandBuilder()
            .setName("room-deny")
            .setDescription("[Chủ phòng] Cấm thành viên tham gia phòng thoại của bạn")
            .addUserOption(option => option.setName("user").setDescription("Thành viên cần cấm").setRequired(true)),
        new SlashCommandBuilder()
            .setName("room-kick")
            .setDescription("[Chủ phòng] Đuổi thành viên ra khỏi phòng thoại của bạn")
            .addUserOption(option => option.setName("user").setDescription("Thành viên cần đuổi").setRequired(true))
    ].map(cmd => cmd.toJSON());

    const rest = new REST({ version: "10" }).setToken(TOKEN);
    try {
        await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
        console.log("✅ Đã đồng bộ Slash Commands thành công!");
    } catch (error) {
        console.error("Lỗi đồng bộ lệnh:", error);
    }
});

client.on("voiceStateUpdate", async (oldState, newState) => {
    const guild = newState.guild;
    const member = newState.member;
    const prefix = process.env.ROOM_PREFIX || "🔊";
    const defaultGenName = process.env.GENERATOR_NAME || "➕・Tạo Phòng";

    if (newState.channel && newState.channel.name === defaultGenName && newState.channel.parentId) {
        const category = newState.channel.category;
        const generatorChannel = newState.channel;
        
        const existingRoom = await getOwnedRoom(guild.id, member.id);
        if (existingRoom) {
            const oldChannel = guild.channels.cache.get(existingRoom.channel_id);
            if (oldChannel) {
                try {
                    await member.voice.setChannel(oldChannel);
                    await sendBlogLog(guild, "TÁI SỬ DỤNG", `${member.user.tag} vào lại phòng cũ ${oldChannel.name}`);
                    return;
                } catch (e) {}
            }
            deleteRoomRecord(existingRoom.channel_id);
        }

        try {
            const targetPosition = generatorChannel.position + 1;

            const newChannel = await guild.channels.create({
                name: `${prefix} Phòng của ${member.displayName}`,
                type: 2,
                parent: category,
                position: targetPosition,
                permissionOverwrites: [
                    {
                        id: guild.id,
                        allow: [PermissionFlagsBits.Connect, PermissionFlagsBits.Speak]
                    }
                ]
            });

            await member.voice.setChannel(newChannel);
            saveRoom(guild.id, newChannel.id, member.id, category.id);
            await sendBlogLog(guild, "TẠO PHÒNG", `Chủ: ${member.user.tag} ➔${newChannel.name}`);

            const embed = new EmbedBuilder()
                .setTitle("🎛️ BẢNG ĐIỀU KHIỂN PHÒNG THOẠI")
                .setDescription(`Chủ phòng: <@${member.id}>\n\nDùng các nút bên dưới để tùy chỉnh không gian, khóa phòng hoặc điều khiển bot đọc giọng nói.`)
                .setColor(0x5865F2)
                .setThumbnail(member.user.displayAvatarURL());

            await newChannel.send({
                content: `👋 Chào mừng <@${member.id}>! Bot đọc giọng nói tiếng Việt đã sẵn sàng trong phòng này.`,
                embeds: [embed],
                components: getVoiceControlRows(true)
            });

            await speakTextInChannel(newChannel, `Xin chào ${member.displayName}, phòng thoại đã được tạo thành công.`);

        } catch (e) {
            console.error("Lỗi tạo phòng thoại:", e);
        }
    }

    if (oldState.channel && oldState.channel.name !== defaultGenName) {
        const room = await getRoom(oldState.channel.id);
        if (room && oldState.channel.members.size === 0) {
            const rId = oldState.channel.id;
            const rName = oldState.channel.name;
            deleteRoomRecord(rId);

            const voiceBotData = activeVoiceBots.get(rId);
            if (voiceBotData) {
                try { voiceBotData.connection.destroy(); } catch (e) {}
                activeVoiceBots.delete(rId);
            }

            try {
                await oldState.channel.delete();
                await sendBlogLog(guild, "XÓA PHÒNG", `Phòng trống \`${rName}\` đã tự động bị xóa`);
            } catch (e) {}
        }
    }
});

client.on("messageCreate", async (message) => {
    if (message.author.bot || !message.guild) return;

    const room = await getRoom(message.channel.id);
    if (room) {
        await sendBlogLog(message.guild, "CHAT PHÒNG", `${message.author.tag} trong #${message.channel.name}:${message.content || "[Đính kèm]"}`);
        await speakTextInChannel(message.channel, `${message.author.displayName} nói: ${message.content}`);
    }

    const gen = await getGenerator(message.guild.id);
    if (gen && gen.tracked_text_channel_id && message.channel.id === gen.tracked_text_channel_id) {
        await sendBlogLog(message.guild, "THEO DÕI CHAT", `${message.author.tag} tại #${message.channel.name}:${message.content || "[Đính kèm]"}`);
    }

    await handleAIQuery(message);
});

client.on("interactionCreate", async (interaction) => {
    if (interaction.isChatInputCommand()) {
        const { commandName } = interaction;
        const guild = interaction.guild;

        if (commandName === "setup") {
            if (!interaction.channel.parentId) {
                return interaction.reply({ content: "❌ Vui lòng dùng lệnh bên trong một kênh thuộc danh mục muốn cài đặt!", ephemeral: true });
            }
            const category = interaction.channel.parent;
            const defaultGenName = process.env.GENERATOR_NAME || "➕・Tạo Phòng";
            const fixedBlogName = process.env.BLOG_CHANNEL_NAME || "💬│blog-chat";

            let generator = category.children.cache.find(c => c.name === defaultGenName);
            if (!generator) {
                generator = await guild.channels.create({ name: defaultGenName, type: 2, parent: category });
            }

            let blogChannel = category.children.cache.find(c => c.name === fixedBlogName);
            if (!blogChannel) {
                blogChannel = await guild.channels.create({ name: fixedBlogName, type: 0, parent: category });
            }

            saveGenerator(guild.id, category.id, generator.id, blogChannel.id);
            return interaction.reply({ content: `✅ Khởi tạo hệ thống phòng thoại và blog thành công tại danh mục **${category.name}**!`, ephemeral: true });
        }

        if (commandName === "track-channel") {
            if (!interaction.channel.isTextBased()) {
                return interaction.reply({ content: "❌ Lệnh này chỉ dùng được trong kênh văn bản!", ephemeral: true });
            }
            updateTrackedChannel(guild.id, interaction.channel.id);
            await sendBlogLog(guild, "GÁN THEO DÕI", `${interaction.user.tag} đã gán kênh #${interaction.channel.name}`);
            return interaction.reply({ content: `✅ Đã gán kênh <#${interaction.channel.id}> vào hệ thống theo dõi thời gian thực!`, ephemeral: true });
        }

        if (commandName === "untrack-channel") {
            clearTrackedChannel(guild.id);
            await sendBlogLog(guild, "HỦY THEO DÕI", `${interaction.user.tag} đã hủy theo dõi kênh`);
            return interaction.reply({ content: "✅ Đã hủy theo dõi kênh chat thành công!", ephemeral: true });
        }

        const voiceChannel = interaction.member.voice.channel;
        if (!voiceChannel) {
            return interaction.reply({ content: "❌ Bạn phải đang ở trong phòng thoại tạm!", ephemeral: true });
        }
        const room = await getRoom(voiceChannel.id);
        if (!room || room.owner_id !== interaction.user.id) {
            return interaction.reply({ content: "❌ Chỉ chủ phòng mới có quyền sử dụng lệnh này!", ephemeral: true });
        }

        const targetUser = interaction.options.getMember("user");
        if (commandName === "room-allow") {
            await voiceChannel.permissionOverwrites.edit(targetUser, { Connect: true, ViewChannel: true });
            return interaction.reply({ content: `✅ Đã cấp quyền cho ${targetUser.user.tag}.`, ephemeral: true });
        }
        if (commandName === "room-deny") {
            await voiceChannel.permissionOverwrites.edit(targetUser, { Connect: false });
            if (targetUser.voice.channelId === voiceChannel.id) await targetUser.voice.disconnect();
            return interaction.reply({ content: `🚫 Đã cấm ${targetUser.user.tag}.`, ephemeral: true });
        }
        if (commandName === "room-kick") {
            if (targetUser.voice.channelId === voiceChannel.id) {
                await targetUser.voice.disconnect();
                return interaction.reply({ content: `👞 Đã đá ${targetUser.user.tag} ra khỏi phòng.`, ephemeral: true });
            }
            return interaction.reply({ content: `❌ Thành viên không ở trong phòng của bạn.`, ephemeral: true });
        }
    }

    if (interaction.isButton()) {
        const customId = interaction.customId;
        const member = interaction.member;
        const voiceChannel = member.voice ? member.voice.channel : null;

        if (customId === "tts_toggle" || customId === "tts_vol_up" || customId === "tts_vol_down") {
            if (!voiceChannel) return interaction.reply({ content: "❌ Bạn phải ở trong phòng thoại để điều chỉnh bot!", ephemeral: true });
            const settings = await getBotSettings(interaction.guild.id);

            if (customId === "tts_toggle") {
                const newState = settings.tts_enabled ? 0 : 1;
                updateBotSettings(interaction.guild.id, newState, null);
                await interaction.update({ components: getVoiceControlRows(newState === 1) });
                return interaction.followup({ content: newState ? "🔊 Đã bật tiếng Bot đọc giọng nói." : "🔇 Đã tắt tiếng Bot đọc giọng nói.", ephemeral: true });
            }

            if (customId === "tts_vol_up" || customId === "tts_vol_down") {
                let newVol = settings.volume + (customId === "tts_vol_up" ? 20 : -20);
                if (newVol > 200) newVol = 200;
                if (newVol < 10) newVol = 10;
                updateBotSettings(interaction.guild.id, null, newVol);

                const voiceBotData = activeVoiceBots.get(voiceChannel.id);
                if (voiceBotData && voiceBotData.player) {
                    voiceBotData.volume = newVol / 100;
                }
                return interaction.reply({ content: `🔊 Đã điều chỉnh âm lượng bot thành **${newVol}%**`, ephemeral: true });
            }
        }

        if (!voiceChannel) return interaction.reply({ content: "❌ Bạn phải ở trong phòng thoại tạm!", ephemeral: true });
        const room = await getRoom(voiceChannel.id);
        
        if (!room || room.owner_id !== member.id) {
            return interaction.reply({ content: "❌ Chỉ có chủ phòng mới có quyền thao tác bảng điều khiển này!", ephemeral: true });
        }

        if (customId === "vc_lock") {
            await voiceChannel.permissionOverwrites.edit(interaction.guild.id, { Connect: false });
            await voiceChannel.permissionOverwrites.edit(member, { Connect: true });
            return interaction.reply({ content: "🔒 Đã khóa phòng thành công!", ephemeral: true });
        }
        if (customId === "vc_unlock") {
            await voiceChannel.permissionOverwrites.edit(interaction.guild.id, { Connect: null });
            return interaction.reply({ content: "🔓 Đã mở khóa phòng thành công!", ephemeral: true });
        }
        if (customId === "vc_hide") {
            await voiceChannel.permissionOverwrites.edit(interaction.guild.id, { ViewChannel: false });
            return interaction.reply({ content: "🥷 Đã ẩn phòng thoại!", ephemeral: true });
        }
        if (customId === "vc_unhide") {
            await voiceChannel.permissionOverwrites.edit(interaction.guild.id, { ViewChannel: null });
            return interaction.reply({ content: "👁️ Đã hiện phòng thoại!", ephemeral: true });
        }
        if (customId === "vc_limit") {
            return interaction.showModal(new LimitModal());
        }
        if (customId === "vc_rename") {
            return interaction.showModal(new RenameModal());
        }
        if (customId === "vc_transfer") {
            return interaction.showModal(new TransferModal());
        }
        if (customId === "vc_reset") {
            const prefix = process.env.ROOM_PREFIX || "🔊";
            await voiceChannel.setName(`${prefix} Phòng của ${member.displayName}`);
            await voiceChannel.setUserLimit(0);
            await voiceChannel.permissionOverwrites.set([]);
            return interaction.reply({ content: "🔄 Đã khôi phục cài đặt gốc phòng!", ephemeral: true });
        }
        if (customId === "vc_claim") {
            if (voiceChannel.members.has(room.owner_id)) {
                return interaction.reply({ content: "❌ Chủ cũ vẫn đang ở trong phòng!", ephemeral: true });
            }
            saveRoom(interaction.guild.id, voiceChannel.id, member.id, voiceChannel.parentId);
            await sendBlogLog(interaction.guild, "NHẬN CHỦ", `${member.user.tag} tiếp quản phòng ${voiceChannel.name}`);
            return interaction.reply({ content: `👑 **${member.displayName}** đã tiếp quản quyền chủ phòng!`, ephemeral: true });
        }
    }

    if (interaction.isModalSubmit()) {
        const voiceChannel = interaction.member.voice ? interaction.member.voice.channel : null;
        if (!voiceChannel) return interaction.reply({ content: "❌ Bạn không ở trong phòng thoại!", ephemeral: true });

        if (interaction.customId === "modal_limit") {
            const val = parseInt(interaction.fields.getTextInputValue("limit_val"));
            if (isNaN(val) || val < 0 || val > 99) {
                return interaction.reply({ content: "❌ Vui lòng nhập số hợp lệ từ 0 đến 99!", ephemeral: true });
            }
            await voiceChannel.setUserLimit(val);
            return interaction.reply({ content: `✅ Đã cập nhật giới hạn phòng thành **${val}** người.`, ephemeral: true });
        }

        if (interaction.customId === "modal_rename") {
            const newNameVal = interaction.fields.getTextInputValue("name_val");
            const prefix = process.env.ROOM_PREFIX || "🔊";
            const fullNewName = `${prefix}${newNameVal}`;
            const oldName = voiceChannel.name;
            await voiceChannel.setName(fullNewName);
            await sendBlogLog(interaction.guild, "ĐỔI TÊN", `${interaction.user.tag} đổi \`${oldName}\` ➔ \`${fullNewName}\``);
            return interaction.reply({ content: `✅ Đã đổi tên phòng thành: **${newNameVal}**`, ephemeral: true });
        }

        if (interaction.customId === "modal_transfer") {
            const targetUid = interaction.fields.getTextInputValue("uid_val").trim();
            const targetMember = interaction.guild.members.cache.get(targetUid);
            if (!targetMember || targetMember.voice.channelId !== voiceChannel.id) {
                return interaction.reply({ content: "❌ Thành viên không hợp lệ hoặc không có trong phòng với bạn.", ephemeral: true });
            }
            saveRoom(interaction.guild.id, voiceChannel.id, targetMember.id, voiceChannel.parentId);
            await sendBlogLog(interaction.guild, "CHỦ PHÒNG", `Phòng ${voiceChannel.name} chuyển quyền cho ${targetMember.user.tag}`);
            return interaction.reply({ content: `👑 Đã chuyển quyền chủ phòng cho <@${targetMember.id}>.`, ephemeral: true });
        }
    }
});

client.login(TOKEN);