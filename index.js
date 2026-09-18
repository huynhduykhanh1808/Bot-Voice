const { 
    Client, 
    GatewayIntentBits, 
    PermissionsBitField, 
    ChannelType, 
    EmbedBuilder, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle, 
    StringSelectMenuBuilder, 
    ModalBuilder, 
    TextInputBuilder, 
    TextInputStyle, 
    REST, 
    Routes 
} = require('discord.js');
const sqlite3 = require('sqlite3').verbose();
const http = require('http');
const googleTTS = require('google-tts-api');
const { joinVoiceChannel, createAudioPlayer, createAudioResource } = require('@discordjs/voice');
require('dotenv').config();

const TOKEN = process.env.DISCORD_TOKEN ? process.env.DISCORD_TOKEN.trim() : '';
const DB_PATH = process.env.DB_PATH || 'tempvoice.db';
const DEFAULT_GENERATOR = process.env.GENERATOR_NAME || '➕・Tạo Phòng';
const FIXED_BLOG_NAME = process.env.BLOG_CHANNEL_NAME || '💬│blog-chat';

if (!TOKEN) {
    console.error("❌ Lỗi: Chưa cấu hình DISCORD_TOKEN trong file .env!");
    process.exit(1);
}

const roomTtsStatus = {};

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Pro Voice Chat Bot (JS) is online!');
});
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`🌐 Web server đang chạy trên cổng ${PORT}`);
});

const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) console.error("❌ Lỗi SQLite:", err.message);
    else console.log("🗄️ Đã kết nối cơ sở dữ liệu SQLite.");
});

function initDatabase() {
    db.serialize(() => {
        db.run(`
            CREATE TABLE IF NOT EXISTS generators (
                guild_id INTEGER PRIMARY KEY,
                category_id INTEGER NOT NULL,
                generator_id INTEGER NOT NULL,
                blog_channel_id INTEGER,
                tracked_text_channel_id INTEGER
            )
        `);
        db.run(`
            CREATE TABLE IF NOT EXISTS rooms (
                guild_id INTEGER NOT NULL,
                channel_id INTEGER PRIMARY KEY,
                owner_id INTEGER NOT NULL,
                category_id INTEGER NOT NULL
            )
        `);
    });
}

const dbGet = (query, params = []) => new Promise((resolve, reject) => {
    db.get(query, params, (err, row) => err ? reject(err) : resolve(row));
});

const dbRun = (query, params = []) => new Promise((resolve, reject) => {
    db.run(query, params, function(err) { err ? reject(err) : resolve(this); });
});

async function sendBlogLog(guild, tag, content) {
    try {
        const gen = await dbGet("SELECT * FROM generators WHERE guild_id = ?", [guild.id]);
        if (gen && gen.blog_channel_id) {
            const blogCh = guild.channels.cache.get(gen.blog_channel_id.toString());
            if (blogCh) {
                const timestamp = Math.floor(Date.now() / 1000);
                const cleanContent = content.replace(/\n/g, ' ');
                const msg = `\`[${tag}]\` <t:${timestamp}:t> - ${cleanContent}`;
                await blogCh.send(msg);
            }
        }
    } catch (e) {
        console.error(`Không thể gửi blog log: ${e.message}`);
    }
}

function getControlRows() {
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('vc_lock').setLabel('Khóa').setStyle(ButtonStyle.Secondary).setEmoji('🔒'),
            new ButtonBuilder().setCustomId('vc_unlock').setLabel('Mở khóa').setStyle(ButtonStyle.Secondary).setEmoji('🔓'),
            new ButtonBuilder().setCustomId('vc_hide').setLabel('Ẩn').setStyle(ButtonStyle.Secondary).setEmoji('🥷'),
            new ButtonBuilder().setCustomId('vc_unhide').setLabel('Hiện').setStyle(ButtonStyle.Secondary).setEmoji('👁️')
        ),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('vc_limit').setLabel('Giới hạn').setStyle(ButtonStyle.Secondary).setEmoji('👥'),
            new ButtonBuilder().setCustomId('vc_rename').setLabel('Đổi tên').setStyle(ButtonStyle.Secondary).setEmoji('✏️'),
            new ButtonBuilder().setCustomId('vc_region').setLabel('Khu vực').setStyle(ButtonStyle.Secondary).setEmoji('🌐'),
            new ButtonBuilder().setCustomId('vc_reset').setLabel('Reset').setStyle(ButtonStyle.Secondary).setEmoji('🔄')
        ),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('vc_claim').setLabel('Nhận chủ').setStyle(ButtonStyle.Secondary).setEmoji('👑'),
            new ButtonBuilder().setCustomId('vc_transfer').setLabel('Chuyển chủ').setStyle(ButtonStyle.Secondary).setEmoji('📤')
        ),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('vc_toggle_tts').setLabel('Đọc tin nhắn (TTS): Bật').setStyle(ButtonStyle.Success).setEmoji('🔊')
        )
    ];
}

async function createRoomDynamic(guild, member, category) {
    const existing = await dbGet("SELECT * FROM rooms WHERE guild_id = ? AND owner_id = ?", [guild.id, member.id]);
    if (existing) {
        const oldChannel = guild.channels.cache.get(existing.channel_id.toString());
        if (oldChannel && oldChannel.type === ChannelType.GuildVoice) {
            try {
                await member.voice.setChannel(oldChannel).catch(() => {});
                await sendBlogLog(guild, "TÁI SỬ DỤNG", `${member.toString()} vào lại phòng ${oldChannel.toString()}`);
                return oldChannel;
            } catch (err) {}
        }
        await dbRun("DELETE FROM rooms WHERE channel_id = ?", [existing.channel_id]);
    }

    const newChannel = await guild.channels.create({
        name: `Phòng của ${member.displayName}`,
        type: ChannelType.GuildVoice,
        parent: category.id
    });

    await member.voice.setChannel(newChannel).catch(() => {});
    await dbRun("INSERT OR REPLACE INTO rooms(guild_id, channel_id, owner_id, category_id) VALUES (?, ?, ?, ?)", 
        [guild.id, newChannel.id, member.id, category.id]);
    
    roomTtsStatus[newChannel.id] = true; 
    await sendBlogLog(guild, "TẠO PHÒNG", `Chủ: ${member.toString()} ➔ ${newChannel.toString()}`);

    const embed = new EmbedBuilder()
        .setTitle("🎛️ BẢNG ĐIỀU KHIỂN PHÒNG")
        .setDescription(`Chủ sở hữu: ${member.toString()}\n\nDùng các nút bên dưới để tùy chỉnh không gian và bật/tắt đọc tin nhắn giọng nói.`)
        .setColor(0x5865F2)
        .setThumbnail(member.displayAvatarURL());

    await newChannel.send({
        content: `👋 Chào mừng ${member.toString()}!`,
        embeds: [embed],
        components: getControlRows()
    });

    return newChannel;
}

client.once('ready', () => {
    initDatabase();
    console.log(`🤖 Bot JS đã khởi chạy thành công: ${client.user.tag}`);
});

client.on('voiceStateUpdate', async (oldState, newState) => {
    const member = newState.member || oldState.member;
    if (!member) return;
    const guild = member.guild;

    if (newState.channel) {
        const genRow = await dbGet("SELECT * FROM generators WHERE generator_id = ?", [newState.channel.id]);
        if (genRow && newState.channel.parentId) {
            const category = guild.channels.cache.get(genRow.category_id.toString());
            if (category) {
                await createRoomDynamic(guild, member, category);
            }
        }
    }

    if (oldState.channel) {
        const roomRow = await dbGet("SELECT * FROM rooms WHERE channel_id = ?", [oldState.channel.id]);
        if (roomRow && oldState.channel.members.size === 0) {
            const rId = oldState.channel.id;
            const rName = oldState.channel.name;
            await dbRun("DELETE FROM rooms WHERE channel_id = ?", [rId]);
            delete roomTtsStatus[rId];

            const vc = guild.voiceStates.cache.get(client.user.id);
            if (vc && vc.channelId === rId) {
                try {
                    const voiceClient = guild.members.me.voice;
                    if (voiceClient) await voiceClient.disconnect();
                } catch (e) {}
            }

            try {
                await oldState.channel.delete("Dọn dẹp phòng trống");
                await sendBlogLog(guild, "XÓA PHÒNG", `Phòng trống \`${rName}\` đã bị xóa`);
            } catch (e) {}
        }
    }
});

client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild) return;

    const room = await dbGet("SELECT * FROM rooms WHERE channel_id = ?", [message.channel.id]);
    if (room) {
        const contentPreview = message.content || "[Tệp đính kèm]";
        await sendBlogLog(message.guild, "CHAT PHÒNG", `${message.author.toString()} trong ${message.channel.toString()}: ${contentPreview}`);

        if (roomTtsStatus[message.channel.id] !== false && message.content) {
            const voiceChannel = message.guild.channels.cache.get(message.channel.id);
            if (voiceChannel && voiceChannel.type === ChannelType.GuildVoice) {
                try {
                    let textToRead = message.content;
                    if (textToRead.length > 150) textToRead = textToRead.substring(0, 150) + "... đoạn sau quá dài.";
                    const speechText = `${message.member?.displayName || message.author.username} nói: ${textToRead}`;

                    const url = googleTTS.getAudioUrl(speechText, {
                        lang: 'vi',
                        slow: false,
                        host: 'https://translate.google.com',
                        timeout: 10000,
                    });

                    const connection = joinVoiceChannel({
                        channelId: voiceChannel.id,
                        guildId: message.guild.id,
                        adapterCreator: message.guild.voiceAdapterCreator,
                    });

                    const player = createAudioPlayer();
                    const resource = createAudioResource(url);
                    connection.subscribe(player);
                    player.play(resource);
                } catch (e) {
                    console.error("Lỗi phát TTS:", e);
                }
            }
        }
    }

    const gen = await dbGet("SELECT * FROM generators WHERE guild_id = ?", [message.guild.id]);
    if (gen && gen.tracked_text_channel_id && message.channel.id === gen.tracked_text_channel_id) {
        const contentPreview = message.content || "[Tệp đính kèm]";
        await sendBlogLog(message.guild, "THEO DÕI CHAT", `${message.author.toString()} tại ${message.channel.toString()}: ${contentPreview}`);
    }
});

client.on('interactionCreate', async (interaction) => {
    if (!interaction.inGuild()) return;

    if (interaction.isChatInputCommand()) {
        if (interaction.commandName === 'setup') {
            if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
                return interaction.reply({ content: "❌ Bạn không có quyền sử dụng lệnh này!", ephemeral: true });
            }
            if (!interaction.channel.parentId) {
                return interaction.reply({ content: "❌ Vui lòng dùng lệnh này bên trong một kênh thuộc danh mục muốn cài đặt!", ephemeral: true });
            }

            const category = interaction.channel.parent;
            let generator = category.children.cache.find(c => c.name === DEFAULT_GENERATOR && c.type === ChannelType.GuildVoice);
            if (!generator) {
                generator = await interaction.guild.channels.create({
                    name: DEFAULT_GENERATOR,
                    type: ChannelType.GuildVoice,
                    parent: category.id
                });
            }

            let blogChannel = category.children.cache.find(c => c.name === FIXED_BLOG_NAME && c.type === ChannelType.GuildText);
            if (!blogChannel) {
                blogChannel = await interaction.guild.channels.create({
                    name: FIXED_BLOG_NAME,
                    type: ChannelType.GuildText,
                    parent: category.id
                });
            }

            await dbRun(`
                INSERT INTO generators(guild_id, category_id, generator_id, blog_channel_id)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(guild_id) DO UPDATE SET
                    category_id=excluded.category_id,
                    generator_id=excluded.generator_id,
                    blog_channel_id=excluded.blog_channel_id
            `, [interaction.guild.id, category.id, generator.id, blogChannel.id]);

            return interaction.reply({ content: `✅ Khởi tạo hệ thống thành công tại danh mục!`, ephemeral: true });
        }

        if (interaction.commandName === 'track-channel') {
            if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
                return interaction.reply({ content: "❌ Bạn không có quyền sử dụng lệnh này!", ephemeral: true });
            }
            if (interaction.channel.type !== ChannelType.GuildText) {
                return interaction.reply({ content: "❌ Lệnh này chỉ dùng trong kênh văn bản!", ephemeral: true });
            }
            await dbRun("UPDATE generators SET tracked_text_channel_id = ? WHERE guild_id = ?", [interaction.channel.id, interaction.guild.id]);
            await sendBlogLog(interaction.guild, "GÁN THEO DÕI", `${interaction.user.toString()} đã gán kênh ${interaction.channel.toString()}`);
            return interaction.reply({ content: `✅ Đã gán kênh ${interaction.channel.toString()} vào hệ thống theo dõi!`, ephemeral: true });
        }

        if (interaction.commandName === 'untrack-channel') {
            if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
                return interaction.reply({ content: "❌ Bạn không có quyền sử dụng lệnh này!", ephemeral: true });
            }
            await dbRun("UPDATE generators SET tracked_text_channel_id = NULL WHERE guild_id = ?", [interaction.guild.id]);
            await sendBlogLog(interaction.guild, "HỦY THEO DÕI", `${interaction.user.toString()} đã hủy theo dõi kênh`);
            return interaction.reply({ content: "✅ Đã hủy theo dõi kênh chat thành công!", ephemeral: true });
        }
    }

    if (interaction.isButton()) {
        const customId = interaction.customId;

        if (customId === 'vc_toggle_tts') {
            const channel = interaction.member.voice?.channel;
            if (!channel) return interaction.reply({ content: "❌ Bạn phải đang ở trong phòng thoại!", ephemeral: true });
            
            const current = roomTtsStatus[channel.id] !== false;
            roomTtsStatus[channel.id] = !current;
            
            const newStatus = roomTtsStatus[channel.id];
            const btn = ButtonBuilder.from(interaction.component)
                .setLabel(newStatus ? "Đọc tin nhắn (TTS): Bật" : "Đọc tin nhắn (TTS): Tắt")
                .setStyle(newStatus ? ButtonStyle.Success : ButtonStyle.Danger);
            
            const row = ActionRowBuilder.from(interaction.message.components[3]);
            row.components[0] = btn;
            
            await interaction.update({ components: interaction.message.components });
            return interaction.followup({ content: `📢 Tính năng đọc tin nhắn trong phòng **${newStatus ? "đã BẬT" : "đã TẮT"}**`, ephemeral: true });
        }

        if (customId === 'vc_region') {
            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId('select_region_menu')
                .setPlaceholder('🌐 Chọn khu vực máy chủ âm thanh...')
                .addOptions([
                    { label: 'Tự động (Automatic)', value: 'auto' },
                    { label: 'Singapore', value: 'singapore' },
                    { label: 'Hong Kong', value: 'hongkong' },
                    { label: 'Japan', value: 'japan' },
                ]);
            return interaction.reply({ components: [new ActionRowBuilder().addComponents(selectMenu)], ephemeral: true });
        }

        const channel = interaction.member.voice?.channel;
        if (!channel) return interaction.reply({ content: "❌ Bạn phải đang ở trong phòng thoại tạm!", ephemeral: true });

        const room = await dbGet("SELECT * FROM rooms WHERE channel_id = ?", [channel.id]);
        const isOwnerOrAdmin = interaction.member.permissions.has(PermissionsBitField.Flags.Administrator) || (room && room.owner_id === interaction.user.id);

        if (customId === 'vc_claim') {
            if (!room) return interaction.reply({ content: "❌ Không phải phòng tạm!", ephemeral: true });
            const owner = interaction.guild.members.cache.get(room.owner_id.toString());
            if (owner && channel.members.has(owner.id)) {
                return interaction.reply({ content: "❌ Chủ cũ vẫn đang ở trong phòng!", ephemeral: true });
            }
            await dbRun("UPDATE rooms SET owner_id = ? WHERE channel_id = ?", [interaction.user.id, channel.id]);
            await sendBlogLog(interaction.guild, "NHẬN CHỦ", `${interaction.user.toString()} tiếp quản phòng ${channel.toString()}`);
            return interaction.reply({ content: `👑 **${interaction.user.displayName}** đã tiếp quản quyền chủ phòng!`, ephemeral: true });
        }

        if (!isOwnerOrAdmin) {
            return interaction.reply({ content: "❌ Chỉ Chủ phòng mới có quyền sử dụng nút này!", ephemeral: true });
        }

        if (customId === 'vc_lock') {
            await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { Connect: false });
            await channel.permissionOverwrites.edit(interaction.user, { Connect: true });
            return interaction.reply({ content: "🔒 Đã khóa phòng thành công!", ephemeral: true });
        }
        if (customId === 'vc_unlock') {
            await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { Connect: null });
            return interaction.reply({ content: "🔓 Đã mở khóa phòng thành công!", ephemeral: true });
        }
        if (customId === 'vc_hide') {
            await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { ViewChannel: false });
            return interaction.reply({ content: "🥷 Đã ẩn phòng thoại!", ephemeral: true });
        }
        if (customId === 'vc_unhide') {
            await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { ViewChannel: null });
            return interaction.reply({ content: "👁️ Đã hiện phòng thoại!", ephemeral: true });
        }
        if (customId === 'vc_limit') {
            const modal = new ModalBuilder().setCustomId('modal_limit').setTitle('⚙️ Giới hạn thành viên');
            const input = new TextInputBuilder().setCustomId('limit_input').setLabel('Số lượng tối đa (0 = Không giới hạn)').setStyle(TextInputStyle.Short).setMaxLength(2).setRequired(true);
            modal.addComponents(new ActionRowBuilder().addComponents(input));
            return interaction.showModal(modal);
        }
        if (customId === 'vc_rename') {
            const modal = new ModalBuilder().setCustomId('modal_rename').setTitle('✏️ Đổi tên phòng');
            const input = new TextInputBuilder().setCustomId('rename_input').setLabel('Tên phòng mới').setStyle(TextInputStyle.Short).setMaxLength(100).setRequired(true);
            modal.addComponents(new ActionRowBuilder().addComponents(input));
            return interaction.showModal(modal);
        }
        if (customId === 'vc_transfer') {
            const modal = new ModalBuilder().setCustomId('modal_transfer').setTitle('👑 Chuyển quyền chủ phòng');
            const input = new TextInputBuilder().setCustomId('transfer_input').setLabel('ID Discord thành viên').setStyle(TextInputStyle.Short).setMaxLength(20).setRequired(true);
            modal.addComponents(new ActionRowBuilder().addComponents(input));
            return interaction.showModal(modal);
        }
        if (customId === 'vc_reset') {
            await channel.edit({ name: `Phòng của ${interaction.user.displayName}`, userLimit: 0, rtcRegion: null });
            await channel.permissionOverwrites.set([]);
            await sendBlogLog(interaction.guild, "RESET", `${interaction.user.toString()} reset phòng ${channel.toString()}`);
            return interaction.reply({ content: "🔄 Đã khôi phục cài đặt gốc phòng!", ephemeral: true });
        }
    }

    if (interaction.isStringSelectMenu() && interaction.customId === 'select_region_menu') {
        const channel = interaction.member.voice?.channel;
        if (!channel) return interaction.reply({ content: "❌ Bạn phải ở trong phòng thoại!", ephemeral: true });
        const val = interaction.values[0];
        try {
            await channel.setRTCRegion(val === 'auto' ? null : val);
            return interaction.reply({ content: `🌐 Đã chuyển khu vực máy chủ thành công!`, ephemeral: true });
        } catch (e) {
            return interaction.reply({ content: `❌ Lỗi đổi khu vực: ${e.message}`, ephemeral: true });
        }
    }

    if (interaction.isModalSubmit()) {
        const channel = interaction.member.voice?.channel;
        if (!channel) return interaction.reply({ content: "❌ Bạn không ở trong phòng thoại!", ephemeral: true });

        if (interaction.customId === 'modal_limit') {
            const val = parseInt(interaction.fields.getTextInputValue('limit_input'), 10);
            if (isNaN(val) || val < 0 || val > 99) return interaction.reply({ content: "❌ Nhập số từ 0 đến 99!", ephemeral: true });
            await channel.setUserLimit(val);
            return interaction.reply({ content: `✅ Đã đổi giới hạn thành **${val}** người.`, ephemeral: true });
        }

        if (interaction.customId === 'modal_rename') {
            const newName = interaction.fields.getTextInputValue('rename_input');
            await channel.setName(newName);
            await sendBlogLog(interaction.guild, "ĐỔI TÊN", `${interaction.user.toString()} đổi tên phòng thành ${newName}`);
            return interaction.reply({ content: `✅ Đã đổi tên phòng thành: **${newName}**`, ephemeral: true });
        }

        if (interaction.customId === 'modal_transfer') {
            const uid = interaction.fields.getTextInputValue('transfer_input').trim();
            const targetMember = interaction.guild.members.cache.get(uid);
            if (!targetMember || targetMember.voice?.channel?.id !== channel.id) {
                return interaction.reply({ content: "❌ Thành viên phải đang ở trong phòng với bạn.", ephemeral: true });
            }
            await dbRun("UPDATE rooms SET owner_id = ? WHERE channel_id = ?", [targetMember.id, channel.id]);
            await sendBlogLog(interaction.guild, "CHUYỂN CHỦ", `Phòng ${channel.toString()} chuyển quyền cho ${targetMember.toString()}`);
            return interaction.reply({ content: `👑 Đã chuyển quyền chủ phòng cho ${targetMember.toString()}.`, ephemeral: true });
        }
    }
});

async function registerCommands() {
    const commands = [
        { name: 'setup', description: '[Admin] Khởi tạo hệ thống phòng thoại và kênh blog' },
        { name: 'track-channel', description: '[Admin] Gán kênh chat để theo dõi thời gian thực' },
        { name: 'untrack-channel', description: '[Admin] Hủy theo dõi kênh chat' }
    ];

    const rest = new REST({ version: '10' }).setToken(TOKEN);
    try {
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log('✅ Đã đăng ký Slash Commands thành công!');
    } catch (error) {
        console.error('Lỗi đăng ký lệnh slash:', error);
    }
}

client.once('ready', () => {
    registerCommands();
});

client.login(TOKEN);