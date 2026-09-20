require('dotenv').config();

const {
    Client,
    GatewayIntentBits,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    PermissionsBitField
} = require('discord.js');

const { Pool } = require('pg');
const http = require('http');

const TOKEN = process.env.DISCORD_TOKEN ? process.env.DISCORD_TOKEN.trim() : '';
const DATABASE_URL = process.env.DATABASE_URL ? process.env.DATABASE_URL.trim() : '';

const DEFAULT_GENERATOR = process.env.GENERATOR_NAME || '➕・Tạo Phòng';
const FIXED_BLOG_NAME = process.env.BLOG_CHANNEL_NAME || '💬│blog-chat';
const ROOM_PREFIX = process.env.ROOM_PREFIX || '🔊';

if (!TOKEN) {
    throw new Error('Chưa có DISCORD_TOKEN trong môi trường!');
}

if (!DATABASE_URL) {
    throw new Error('Chưa có DATABASE_URL (Neon PostgreSQL) trong môi trường!');
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

const PORT = process.env.PORT || 8080;

http.createServer((req, res) => {
    res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8'
    });
    res.end('Voice Chat Bot (JavaScript) is alive!');
}).listen(PORT, () => {
    console.log(`Web server đã chạy trên cổng ${PORT}`);
});

// ============================================================
// DATABASE
// ============================================================

async function initDb() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS generators (
                guild_id BIGINT PRIMARY KEY,
                category_id BIGINT NOT NULL,
                generator_id BIGINT NOT NULL,
                blog_channel_id BIGINT,
                tracked_text_channel_id BIGINT
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS rooms (
                guild_id BIGINT NOT NULL,
                channel_id BIGINT PRIMARY KEY,
                owner_id BIGINT NOT NULL,
                category_id BIGINT NOT NULL
            )
        `);

        console.log('Đã kết nối và khởi tạo cơ sở dữ liệu Neon thành công!');
    } catch (e) {
        console.error('Lỗi khởi tạo DB:', e);
    }
}

async function getGenerator(guildId) {
    const res = await pool.query(
        'SELECT * FROM generators WHERE guild_id = $1',
        [guildId]
    );
    return res.rows[0] || null;
}

async function saveGenerator(
    guildId,
    categoryId,
    generatorId,
    blogChannelId,
    trackedTextChannelId = null
) {
    await pool.query(`
        INSERT INTO generators(
            guild_id,
            category_id,
            generator_id,
            blog_channel_id,
            tracked_text_channel_id
        )
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (guild_id) DO UPDATE SET
            category_id = EXCLUDED.category_id,
            generator_id = EXCLUDED.generator_id,
            blog_channel_id = COALESCE(
                EXCLUDED.blog_channel_id,
                generators.blog_channel_id
            ),
            tracked_text_channel_id = COALESCE(
                EXCLUDED.tracked_text_channel_id,
                generators.tracked_text_channel_id
            )
    `, [
        guildId,
        categoryId,
        generatorId,
        blogChannelId,
        trackedTextChannelId
    ]);
}

async function updateTrackedChannel(guildId, channelId) {
    await pool.query(
        'UPDATE generators SET tracked_text_channel_id = $1 WHERE guild_id = $2',
        [channelId, guildId]
    );
}

async function clearTrackedChannel(guildId) {
    await pool.query(
        'UPDATE generators SET tracked_text_channel_id = NULL WHERE guild_id = $1',
        [guildId]
    );
}

async function saveRoom(guildId, channelId, ownerId, categoryId) {
    await pool.query(`
        INSERT INTO rooms(
            guild_id,
            channel_id,
            owner_id,
            category_id
        )
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (channel_id)
        DO UPDATE SET owner_id = EXCLUDED.owner_id
    `, [
        guildId,
        channelId,
        ownerId,
        categoryId
    ]);
}

async function getRoom(channelId) {
    const res = await pool.query(
        'SELECT * FROM rooms WHERE channel_id = $1',
        [channelId]
    );
    return res.rows[0] || null;
}

async function getOwnedRoom(guildId, ownerId) {
    const res = await pool.query(
        'SELECT * FROM rooms WHERE guild_id = $1 AND owner_id = $2',
        [guildId, ownerId]
    );
    return res.rows[0] || null;
}

async function deleteRoomRecord(channelId) {
    await pool.query(
        'DELETE FROM rooms WHERE channel_id = $1',
        [channelId]
    );
}

// ============================================================
// BLOG LOG
// ============================================================

async function sendBlogLog(guild, tag, content) {
    try {
        const gen = await getGenerator(guild.id);
        if (gen && gen.blog_channel_id) {
            const blogCh = guild.channels.cache.get(
                gen.blog_channel_id.toString()
            );
            if (blogCh) {
                const timestamp = Math.floor(Date.now() / 1000);
                const cleanContent = content.replace(/\n/g, ' ');
                await blogCh.send(
                    `\`[${tag}]\` <t:${timestamp}:t> -${cleanContent}`
                );
            }
        }
    } catch (e) {
        console.error('Không thể gửi blog log:', e);
    }
}

// ============================================================
// CONTROL BUTTONS
// ============================================================

function getControlRows(isOwner) {
    if (isOwner) {
        const row1 = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('vc_lock')
                .setLabel('Khóa phòng')
                .setStyle(ButtonStyle.Secondary)
                .setEmoji('🔒'),

            new ButtonBuilder()
                .setCustomId('vc_unlock')
                .setLabel('Mở phòng')
                .setStyle(ButtonStyle.Primary)
                .setEmoji('🔓'),

            new ButtonBuilder()
                .setCustomId('vc_hide')
                .setLabel('Ẩn phòng')
                .setStyle(ButtonStyle.Secondary)
                .setEmoji('🥷'),

            new ButtonBuilder()
                .setCustomId('vc_unhide')
                .setLabel('Hiện phòng')
                .setStyle(ButtonStyle.Primary)
                .setEmoji('👁️')
        );

        const row2 = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('vc_rename')
                .setLabel('Đổi tên')
                .setStyle(ButtonStyle.Primary)
                .setEmoji('✏️'),

            new ButtonBuilder()
                .setCustomId('vc_limit')
                .setLabel('Giới hạn')
                .setStyle(ButtonStyle.Primary)
                .setEmoji('👥'),

            new ButtonBuilder()
                .setCustomId('vc_region')
                .setLabel('Chọn khu vực')
                .setStyle(ButtonStyle.Success)
                .setEmoji('🌐')
        );

        const row3 = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('vc_allow')
                .setLabel('Cấp quyền')
                .setStyle(ButtonStyle.Success)
                .setEmoji('✅'),

            new ButtonBuilder()
                .setCustomId('vc_deny')
                .setLabel('Cấm')
                .setStyle(ButtonStyle.Danger)
                .setEmoji('🚫'),

            new ButtonBuilder()
                .setCustomId('vc_kick')
                .setLabel('Đuổi')
                .setStyle(ButtonStyle.Danger)
                .setEmoji('🩴'),

            new ButtonBuilder()
                .setCustomId('vc_transfer')
                .setLabel('Chuyển chủ')
                .setStyle(ButtonStyle.Success)
                .setEmoji('👑')
        );

        return [row1, row2, row3];
    }

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('vc_claim')
            .setLabel('Nhận chủ phòng')
            .setStyle(ButtonStyle.Success)
            .setEmoji('👑'),

        new ButtonBuilder()
            .setCustomId('vc_info')
            .setLabel('Thông tin phòng')
            .setStyle(ButtonStyle.Primary)
            .setEmoji('ℹ️')
    );

    return [row];
}

// ============================================================
// READY
// ============================================================

client.once('ready', async () => {
    await initDb();
    client.user.setActivity('Quản lý phòng thoại chuyên nghiệp');

    for (const guild of client.guilds.cache.values()) {
        const me = guild.members.me;
        if (me) {
            console.log(
                `[PERMISSION] ${guild.name} | ` +
                `Administrator=${me.permissions.has(
                    PermissionsBitField.Flags.Administrator
                )} | ` +
                `ManageChannels=${me.permissions.has(
                    PermissionsBitField.Flags.ManageChannels
                )}`
            );
        }
    }

    console.log(`Đăng nhập thành công bot: ${client.user.tag}`);

    await client.application.commands.set([
        {
            name: 'setup',
            description: '[Admin] Khởi tạo hệ thống phòng thoại chọn danh mục trực quan',
            defaultMemberPermissions:
                PermissionsBitField.Flags.Administrator.toString()
        },
        {
            name: 'track-channel',
            description: '[Admin] Gán kênh chat hiện tại để theo dõi thời gian thực',
            defaultMemberPermissions:
                PermissionsBitField.Flags.Administrator.toString()
        },
        {
            name: 'untrack-channel',
            description: '[Admin] Hủy theo dõi kênh chat hiện tại',
            defaultMemberPermissions:
                PermissionsBitField.Flags.Administrator.toString()
        }
    ]);

    console.log('Đã đồng bộ Slash Commands thành công!');
});

// ============================================================
// VOICE STATE
// ============================================================

client.on('voiceStateUpdate', async (oldState, newState) => {
    try {
        const member = newState.member || oldState.member;
        if (!member || member.user.bot) return;

        const guild = member.guild;

        if (
            newState?.channelId &&
            (!oldState?.channelId || oldState.channelId !== newState.channelId)
        ) {
            const gen = await getGenerator(guild.id);
            if (
                gen &&
                gen.generator_id &&
                newState.channelId === gen.generator_id.toString()
            ) {
                await createRoom(guild, member, newState.channel.parent);
            }
        }

        if (
            oldState?.channelId &&
            (!newState?.channelId || oldState.channelId !== newState.channelId)
        ) {
            const gen = await getGenerator(guild.id);
            if (
                gen &&
                gen.generator_id &&
                oldState.channelId === gen.generator_id.toString()
            ) {
                return;
            }

            const room = await getRoom(oldState.channelId);
            const oldChannel = oldState.channel;

            if (room && oldChannel && oldChannel.members.size === 0) {
                const rId = oldChannel.id;
                const rName = oldChannel.name;

                await deleteRoomRecord(rId);

                try {
                    await oldChannel.delete();
                    await sendBlogLog(
                        guild,
                        'XÓA PHÒNG',
                        `Phòng trống \`${rName}\` đã bị xóa tự động`
                    );
                } catch (e) {}
            }
        }
    } catch (err) {
        console.error('Lỗi trong voiceStateUpdate:', err);
    }
});

// ============================================================
// CREATE ROOM
// ============================================================

async function createRoom(guild, member, category) {
    const existing = await getOwnedRoom(guild.id, member.id);

    if (existing) {
        const oldCh = guild.channels.cache.get(existing.channel_id.toString());
        if (oldCh && oldCh.isVoiceBased()) {
            try {
                await member.voice.setChannel(oldCh);
                await sendBlogLog(
                    guild,
                    'TÁI SỬ DỤNG',
                    `${member} vào lại phòng ${oldCh}`
                );
                return oldCh;
            } catch (e) {}
        }
        await deleteRoomRecord(existing.channel_id);
    }

    const botMember = guild.members.me;
    if (!botMember) {
        throw new Error('Không tìm thấy thành viên bot trong server.');
    }

    if (!botMember.permissions.has(PermissionsBitField.Flags.ManageChannels)) {
        throw new Error('Bot thiếu quyền ManageChannels.');
    }

    const newChannel = await guild.channels.create({
        name: `${ROOM_PREFIX} Phòng của ${member.displayName}`,
        type: 2,
        parent: category ? category.id : null,
        rtcRegion: null,
        permissionOverwrites: [
            {
                id: guild.roles.everyone.id,
                ViewChannel: true,
                Connect: true,
                Speak: true,
                UseVAD: true
            },
            {
                id: botMember.id,
                ViewChannel: true,
                Connect: true,
                ManageChannels: true,
                ManageRoles: true,
                MoveMembers: true,
                MuteMembers: true,
                DeafenMembers: true,
                Stream: true,
                Speak: true,
                UseVAD: true
            },
            {
                id: member.id,
                ViewChannel: true,
                Connect: true,
                ManageChannels: true,
                ManageRoles: true,
                MoveMembers: true,
                MuteMembers: true,
                DeafenMembers: true,
                Stream: true,
                Speak: true,
                UseVAD: true
            }
        ]
    });

    await member.voice.setChannel(newChannel);
    await saveRoom(guild.id, newChannel.id, member.id, category ? category.id : 0);
    await sendBlogLog(guild, 'TẠO PHÒNG', `Chủ: ${member} ➔${newChannel}`);

    const embed = new EmbedBuilder()
        .setTitle('🛡️ TRUNG TÂM QUẢN LÝ PHÒNG THOẠI')
        .setDescription(
            `👑 **Chủ phòng:** ${member}\n\n` +
            `📜 **NỘI QUY & GIAO LƯU VĂN MINH:**\n` +
            `• Trò chuyện văn minh, lịch sự và tôn trọng lẫn nhau.\n` +
            `• Tuyệt đối không có hành vi xúc phạm, đả kích hay dùng từ ngữ kém văn hóa.\n` +
            `• Cùng nhau xây dựng không gian giao lưu vui vẻ, lành mạnh và tràn ngập những giá trị tích cực! ✨`
        )
        .setColor(0x1E90FF)
        .setThumbnail(member.user.displayAvatarURL())
        .setFooter({ text: 'Hệ thống quản lý phòng thoại tự động' })
        .setTimestamp();

    await newChannel.send({
        content: `👋 Xin chào **${member.displayName}**, phòng riêng của bạn đã sẵn sàng!`,
        embeds: [embed],
        components: getControlRows(true)
    });

    return newChannel;
}

// ============================================================
// MESSAGE LOG
// ============================================================

client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild) return;

    const room = await getRoom(message.channel.id);
    if (room) {
        const contentPreview = message.content || '[Tệp đính kèm]';
        await sendBlogLog(
            message.guild,
            'CHAT PHÒNG',
            `${message.author} trong ${message.channel}:${contentPreview}`
        );
    }

    const gen = await getGenerator(message.guild.id);
    if (
        gen &&
        gen.tracked_text_channel_id &&
        message.channel.id === gen.tracked_text_channel_id.toString()
    ) {
        const contentPreview = message.content || '[Tệp đính kèm]';
        await sendBlogLog(
            message.guild,
            'THEO DÕI CHAT',
            `${message.author} tại ${message.channel}:${contentPreview}`
        );
    }
});

// ============================================================
// ROOM VISIBILITY
// ============================================================

async function setRoomVisibility(channel, hidden) {
    const guild = channel.guild;
    const botMember = guild.members.me;
    const room = await getRoom(channel.id);

    if (!botMember) {
        throw new Error('Không tìm thấy bot member.');
    }

    if (!botMember.permissions.has(PermissionsBitField.Flags.ManageChannels)) {
        throw new Error('Bot thiếu quyền ManageChannels.');
    }

    await channel.permissionOverwrites.edit(
        guild.roles.everyone.id,
        { ViewChannel: hidden ? false : true },
        { reason: hidden ? 'Ẩn phòng bằng bot' : 'Hiện phòng bằng bot' }
    );

    if (room) {
        await channel.permissionOverwrites.edit(
            room.owner_id.toString(),
            {
                ViewChannel: true,
                Connect: true,
                Speak: true,
                UseVAD: true,
                ManageChannels: true,
                ManageRoles: true,
                MoveMembers: true,
                MuteMembers: true,
                DeafenMembers: true
            },
            { reason: 'Đảm bảo chủ phòng có quyền quản lý phòng' }
        );
    }

    await channel.permissionOverwrites.edit(
        botMember.id,
        {
            ViewChannel: true,
            Connect: true,
            ManageChannels: true,
            ManageRoles: true,
            MoveMembers: true,
            MuteMembers: true,
            DeafenMembers: true,
            Speak: true,
            UseVAD: true
        },
        { reason: 'Đảm bảo bot có quyền quản trị phòng' }
    );

    return hidden;
}

// ============================================================
// ENSURE BOT / OWNER PERMISSIONS
// ============================================================

async function ensureRoomManagementPermissions(channel, ownerId) {
    const guild = channel.guild;
    const botMember = guild.members.me;

    if (!botMember) {
        throw new Error('Không tìm thấy bot member.');
    }

    if (!botMember.permissions.has(PermissionsBitField.Flags.ManageChannels)) {
        throw new Error('Bot thiếu quyền ManageChannels.');
    }

    await channel.permissionOverwrites.edit(
        botMember.id,
        {
            ViewChannel: true,
            Connect: true,
            ManageChannels: true,
            ManageRoles: true,
            MoveMembers: true,
            MuteMembers: true,
            DeafenMembers: true,
            Speak: true,
            UseVAD: true
        },
        { reason: 'Cấp quyền quản trị phòng cho bot' }
    );

    if (ownerId) {
        await channel.permissionOverwrites.edit(
            ownerId.toString(),
            {
                ViewChannel: true,
                Connect: true,
                ManageChannels: true,
                ManageRoles: true,
                MoveMembers: true,
                MuteMembers: true,
                DeafenMembers: true,
                Speak: true,
                UseVAD: true
            },
            { reason: 'Cấp quyền quản trị phòng cho chủ phòng' }
        );
    }
}

// ============================================================
// INTERACTION CREATE
// ============================================================

client.on('interactionCreate', async (interaction) => {
    if (!interaction.guild) return;

    // ====================================================
    // SLASH COMMAND
    // ====================================================

    if (interaction.isChatInputCommand()) {
        if (interaction.commandName === 'setup') {
            const categories = interaction.guild.channels.cache.filter(
                c => c.type === 4
            );
            if (categories.size === 0) {
                return interaction.reply({
                    content: '❌ Server chưa có danh mục (Category) nào!',
                    ephemeral: true
                });
            }

            const options = categories.first(25).map(cat => ({
                label: cat.name,
                value: cat.id,
                emoji: '📁'
            }));

            const row = new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId('setup_category_select')
                    .setPlaceholder('📂 Chọn danh mục (Category) để cài đặt hệ thống...')
                    .addOptions(options)
            );

            return interaction.reply({
                content: '📂 **Vui lòng chọn danh mục bên dưới để cấu hình bot:**',
                components: [row],
                ephemeral: true
            });
        }

        if (interaction.commandName === 'track-channel') {
            if (!interaction.channel.isTextBased()) {
                return interaction.reply({
                    content: '❌ Lệnh này chỉ dùng được trong kênh văn bản!',
                    ephemeral: true
                });
            }

            await updateTrackedChannel(
                interaction.guild.id,
                interaction.channel.id
            );
            await sendBlogLog(
                interaction.guild,
                'GÁN THEO DÕI',
                `${interaction.user} đã gán kênh ${interaction.channel}`
            );

            return interaction.reply({
                content: `✅ Đã gán kênh ${interaction.channel} vào hệ thống theo dõi thời gian thực!`,
                ephemeral: true
            });
        }

        if (interaction.commandName === 'untrack-channel') {
            await clearTrackedChannel(interaction.guild.id);
            await sendBlogLog(
                interaction.guild,
                'HỦY THEO DÕI',
                `${interaction.user} đã hủy theo dõi kênh`
            );

            return interaction.reply({
                content: '✅ Đã hủy theo dõi kênh chat thành công!',
                ephemeral: true
            });
        }

        return;
    }

    // ====================================================
    // STRING SELECT MENU
    // ====================================================

    if (interaction.isStringSelectMenu()) {
        if (interaction.customId === 'setup_category_select') {
            const catId = interaction.values[0];
            const category = interaction.guild.channels.cache.get(catId);

            if (!category) {
                return interaction.reply({
                    content: '❌ Danh mục không hợp lệ!',
                    ephemeral: true
                });
            }

            let generator = category.children.cache.find(
                c => c.name === DEFAULT_GENERATOR && c.isVoiceBased()
            );

            if (!generator) {
                generator = await interaction.guild.channels.create({
                    name: DEFAULT_GENERATOR,
                    type: 2,
                    parent: category.id
                });
            }

            let blogChannel = category.children.cache.find(
                c => c.name === FIXED_BLOG_NAME && !c.isVoiceBased()
            );

            if (!blogChannel) {
                blogChannel = await interaction.guild.channels.create({
                    name: FIXED_BLOG_NAME,
                    type: 0,
                    parent: category.id
                });
            }

            await saveGenerator(
                interaction.guild.id,
                category.id,
                generator.id,
                blogChannel.id
            );

            return interaction.update({
                content:
                    `✅ **Khởi tạo hệ thống thành công!**\n` +
                    `- Danh mục: **${category.name}**\n` +
                    `- Kênh tạo phòng: ${generator}\n` +
                    `- Kênh Blog Log: ${blogChannel}`,
                components: []
            });
        }

        if (interaction.customId === 'region_select_menu') {
            const channel = interaction.member?.voice?.channel;
            if (!channel) {
                return interaction.reply({
                    content: '❌ Bạn cần ở trong phòng thoại để đổi khu vực.',
                    ephemeral: true
                });
            }

            const room = await getRoom(channel.id);
            if (
                !room ||
                room.owner_id.toString() !== interaction.user.id
            ) {
                return interaction.reply({
                    content: '❌ Chỉ chủ phòng mới có quyền đổi khu vực máy chủ.',
                    ephemeral: true
                });
            }

            const val = interaction.values[0];
            const regionVal = val === 'auto' ? null : val;
            await channel.setRTCRegion(regionVal);

            await sendBlogLog(
                interaction.guild,
                'ĐỔI KHU VỰC',
                `${interaction.user} đổi khu vực phòng thành ${val.toUpperCase()}`
            );

            return interaction.update({
                content: `🌐 Đã chuyển khu vực máy chủ âm thanh sang: **${val.toUpperCase()}**`,
                components: []
            });
        }
    }

    // ====================================================
    // BUTTONS
    // ====================================================

    if (interaction.isButton()) {
        const channel = interaction.member?.voice?.channel;
        if (!channel) {
            return interaction.reply({
                content: '❌ Bạn cần tham gia vào phòng thoại trước khi sử dụng tính năng này.',
                ephemeral: true
            });
        }

        const room = await getRoom(channel.id);
        const isOwner =
            room && room.owner_id.toString() === interaction.user.id;
        const customId = interaction.customId;

        if (customId === 'vc_claim') {
            if (!room) {
                return interaction.reply({
                    content: '❌ Đây không phải là phòng thoại tạm!',
                    ephemeral: true
                });
            }

            const owner = interaction.guild.members.cache.get(
                room.owner_id.toString()
            );

            if (owner && channel.members.has(owner.id)) {
                return interaction.reply({
                    content: '❌ Chủ phòng cũ vẫn đang ở trong phòng, chưa thể nhận quyền.',
                    ephemeral: true
                });
            }

            await saveRoom(
                interaction.guild.id,
                channel.id,
                interaction.user.id,
                channel.parentId || 0
            );
            await ensureRoomManagementPermissions(
                channel,
                interaction.user.id
            );

            await sendBlogLog(
                interaction.guild,
                'NHẬN CHỦ',
                `${interaction.user} tiếp quản phòng ${channel}`
            );

            const newEmbed = new EmbedBuilder()
                .setTitle('🛡️ TRUNG TÂM QUẢN LÝ PHÒNG THOẠI')
                .setDescription(
                    `👑 **Chủ phòng:** ${interaction.user}\n\n` +
                    `📜 **NỘI QUY & GIAO LƯU VĂN MINH:**\n` +
                    `• Trò chuyện văn minh, lịch sự và tôn trọng lẫn nhau.\n` +
                    `• Tuyệt đối không có hành vi xúc phạm, đả kích hay dùng từ ngữ kém văn hóa.\n` +
                    `• Cùng nhau xây dựng không gian giao lưu vui vẻ, lành mạnh và tràn ngập những giá trị tích cực! ✨`
                )
                .setColor(0x1E90FF)
                .setThumbnail(interaction.user.displayAvatarURL())
                .setFooter({ text: 'Hệ thống quản lý phòng thoại tự động' })
                .setTimestamp();

            try {
                await interaction.message.edit({
                    embeds: [newEmbed],
                    components: getControlRows(true)
                });
            } catch (e) {}

            return interaction.reply({
                content: `👑 Chúc mừng **${interaction.user.displayName}** đã tiếp quản quyền chủ phòng thành công!`,
                ephemeral: true
            });
        }

        if (customId === 'vc_info') {
            let ownerName = 'Không xác định';
            if (room) {
                const ownerObj = interaction.guild.members.cache.get(
                    room.owner_id.toString()
                );
                if (ownerObj) ownerName = ownerObj.displayName;
            }

            return interaction.reply({
                content:
                    `ℹ️ **Thông tin phòng thoại:**\n` +
                    `- Tên phòng: ${channel.name}\n` +
                    `- Chủ phòng: ${ownerName}\n` +
                    `- Thành viên đang tham gia: ${channel.members.size} người`,
                ephemeral: true
            });
        }

        if (!isOwner) {
            return interaction.reply({
                content: '❌ Chỉ chủ phòng mới có quyền thực hiện các thao tác quản lý này.',
                ephemeral: true
            });
        }

        if (customId === 'vc_lock') {
            await channel.permissionOverwrites.edit(
                interaction.guild.roles.everyone,
                { Connect: false }
            );
            await ensureRoomManagementPermissions(channel, interaction.user.id);
            await sendBlogLog(
                interaction.guild,
                'KHÓA',
                `${interaction.user} đã khóa phòng`
            );
            return interaction.deferUpdate();
        }

        if (customId === 'vc_unlock') {
            await channel.permissionOverwrites.edit(
                interaction.guild.roles.everyone,
                { Connect: true }
            );
            await ensureRoomManagementPermissions(channel, interaction.user.id);
            await sendBlogLog(
                interaction.guild,
                'MỞ KHÓA',
                `${interaction.user} đã mở khóa phòng`
            );
            return interaction.deferUpdate();
        }

        if (customId === 'vc_hide') {
            try {
                await setRoomVisibility(channel, true);
                await sendBlogLog(
                    interaction.guild,
                    'ẨN',
                    `${interaction.user} đã ẩn phòng ${channel}`
                );
                return interaction.update({
                    content: '🥷 **Phòng đã được ẩn.** Thành viên không có quyền riêng sẽ không còn nhìn thấy phòng này.',
                    components: getControlRows(true)
                });
            } catch (error) {
                console.error('Lỗi vc_hide:', error);
                return interaction.reply({
                    content: '❌ Bot không thể ẩn phòng. Hãy kiểm tra lại quyền của bot.',
                    ephemeral: true
                });
            }
        }

        if (customId === 'vc_unhide') {
            try {
                await setRoomVisibility(channel, false);
                await sendBlogLog(
                    interaction.guild,
                    'HIỆN',
                    `${interaction.user} đã hiển thị lại phòng ${channel}`
                );
                return interaction.update({
                    content: '👁️ **Phòng đã được hiện trở lại** cho tất cả thành viên.',
                    components: getControlRows(true)
                });
            } catch (error) {
                console.error('Lỗi vc_unhide:', error);
                return interaction.reply({
                    content: '❌ Bot không thể hiện phòng. Hãy kiểm tra quyền **Manage Channels** của bot.',
                    ephemeral: true
                });
            }
        }

        if (customId === 'vc_region') {
            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId('region_select_menu')
                .setPlaceholder('🌐 [Bấm vào đây để chọn khu vực máy chủ]')
                .addOptions([
                    { label: 'Tự động chọn khu vực (Automatic)', value: 'auto' },
                    { label: 'Singapore', value: 'singapore' },
                    { label: 'Hong Kong', value: 'hongkong' },
                    { label: 'Japan (Nhật Bản)', value: 'japan' },
                    { label: 'Sydney (Úc)', value: 'sydney' },
                    { label: 'India (Ấn Độ)', value: 'india' },
                    { label: 'Europe (Châu Âu)', value: 'europe' },
                    { label: 'US East (Mỹ Đông)', value: 'us-east' },
                    { label: 'US West (Mỹ Tây)', value: 'us-west' }
                ]);

            const row = new ActionRowBuilder().addComponents(selectMenu);
            return interaction.reply({
                content: '🌐 **BẢNG CHỌN KHU VỰC MÁY CHỦ ÂM THANH:**',
                components: [row],
                ephemeral: true
            });
        }

        if (customId === 'vc_rename') {
            const modal = new ModalBuilder()
                .setCustomId('modal_rename')
                .setTitle('✏️ Đổi tên phòng');
            const input = new TextInputBuilder()
                .setCustomId('input_rename')
                .setLabel('Nhập tên phòng mới')
                .setStyle(TextInputStyle.Short)
                .setMaxLength(40)
                .setRequired(true);
            modal.addComponents(new ActionRowBuilder().addComponents(input));
            return interaction.showModal(modal);
        }

        if (customId === 'vc_limit') {
            const modal = new ModalBuilder()
                .setCustomId('modal_limit')
                .setTitle('⚙️ Giới hạn số người');
            const input = new TextInputBuilder()
                .setCustomId('input_limit')
                .setLabel('Nhập số lượng tối đa (0 - 99)')
                .setStyle(TextInputStyle.Short)
                .setMaxLength(2)
                .setRequired(true);
            modal.addComponents(new ActionRowBuilder().addComponents(input));
            return interaction.showModal(modal);
        }

        if (customId === 'vc_allow') {
            const modal = new ModalBuilder()
                .setCustomId('modal_allow')
                .setTitle('✅ Cấp quyền vào phòng');
            const input = new TextInputBuilder()
                .setCustomId('input_uid')
                .setLabel('Nhập ID Discord của thành viên')
                .setStyle(TextInputStyle.Short)
                .setMaxLength(25)
                .setRequired(true);
            modal.addComponents(new ActionRowBuilder().addComponents(input));
            return interaction.showModal(modal);
        }

        if (customId === 'vc_deny') {
            const modal = new ModalBuilder()
                .setCustomId('modal_deny')
                .setTitle('🚫 Cấm thành viên');
            const input = new TextInputBuilder()
                .setCustomId('input_uid')
                .setLabel('Nhập ID Discord thành viên cần cấm')
                .setStyle(TextInputStyle.Short)
                .setMaxLength(25)
                .setRequired(true);
            modal.addComponents(new ActionRowBuilder().addComponents(input));
            return interaction.showModal(modal);
        }

        if (customId === 'vc_kick') {
            const modal = new ModalBuilder()
                .setCustomId('modal_kick')
                .setTitle('🩴 Mời rời phòng');
            const input = new TextInputBuilder()
                .setCustomId('input_uid')
                .setLabel('Nhập ID Discord cần mời ra')
                .setStyle(TextInputStyle.Short)
                .setMaxLength(25)
                .setRequired(true);
            modal.addComponents(new ActionRowBuilder().addComponents(input));
            return interaction.showModal(modal);
        }

        if (customId === 'vc_transfer') {
            const modal = new ModalBuilder()
                .setCustomId('modal_transfer')
                .setTitle('👑 Chuyển chủ phòng');
            const input = new TextInputBuilder()
                .setCustomId('input_uid')
                .setLabel('Nhập ID Discord người nhận quyền')
                .setStyle(TextInputStyle.Short)
                .setMaxLength(25)
                .setRequired(true);
            modal.addComponents(new ActionRowBuilder().addComponents(input));
            return interaction.showModal(modal);
        }

        return;
    }

    // ====================================================
    // MODAL SUBMIT
    // ====================================================

    if (interaction.isModalSubmit()) {
        const channel = interaction.member?.voice?.channel;
        if (!channel) {
            return interaction.reply({
                content: '❌ Bạn phải ở trong phòng thoại!',
                ephemeral: true
            });
        }

        const room = await getRoom(channel.id);
        if (
            !room ||
            room.owner_id.toString() !== interaction.user.id
        ) {
            return interaction.reply({
                content: '❌ Chỉ chủ phòng mới có quyền thực hiện thao tác này.',
                ephemeral: true
            });
        }

        if (interaction.customId === 'modal_rename') {
            const newNameVal = interaction.fields
                .getTextInputValue('input_rename')
                .trim();
            const oldName = channel.name;
            const newRoomName = `${ROOM_PREFIX}${newNameVal}`;

            await channel.setName(newRoomName);
            await sendBlogLog(
                interaction.guild,
                'ĐỔI TÊN',
                `${interaction.user} đổi \`${oldName}\` ➔ \`${newRoomName}\``
            );

            return interaction.reply({
                content: `✅ Đã đổi tên phòng thành: **${newNameVal}**`,
                ephemeral: true
            });
        }

        if (interaction.customId === 'modal_limit') {
            const limitVal = parseInt(
                interaction.fields.getTextInputValue('input_limit')
            );
            if (isNaN(limitVal) || limitVal < 0 || limitVal > 99) {
                return interaction.reply({
                    content: '❌ Vui lòng nhập số hợp lệ từ 0 đến 99.',
                    ephemeral: true
                });
            }

            await channel.setUserLimit(limitVal);
            await sendBlogLog(
                interaction.guild,
                'GIỚI HẠN',
                `${interaction.user} đặt giới hạn phòng thành ${limitVal}`
            );

            return interaction.reply({
                content: `✅ Đã cập nhật giới hạn phòng thành **${limitVal}** người.`,
                ephemeral: true
            });
        }

        if (
            ['modal_allow', 'modal_deny', 'modal_kick'].includes(
                interaction.customId
            )
        ) {
            const uidStr = interaction.fields
                .getTextInputValue('input_uid')
                .trim();
            const uid = parseInt(uidStr);

            if (isNaN(uid)) {
                return interaction.reply({
                    content: '❌ ID Discord không hợp lệ. Vui lòng kiểm tra lại.',
                    ephemeral: true
                });
            }

            let targetMember;
            try {
                targetMember = await interaction.guild.members.fetch(uid);
            } catch (err) {
                return interaction.reply({
                    content: '❌ Không tìm thấy thành viên này trong server.',
                    ephemeral: true
                });
            }

            if (interaction.customId === 'modal_allow') {
                await channel.permissionOverwrites.edit(targetMember, {
                    Connect: true,
                    ViewChannel: true
                });
                await sendBlogLog(
                    interaction.guild,
                    'CẤP QUYỀN',
                    `${interaction.user} cấp quyền cho ${targetMember}`
                );
                return interaction.reply({
                    content: `✅ Đã cấp quyền vào phòng thành công cho **${targetMember.displayName}**.`,
                    ephemeral: true
                });
            }

            if (interaction.customId === 'modal_deny') {
                await channel.permissionOverwrites.edit(targetMember, {
                    Connect: false
                });
                if (
                    targetMember.voice &&
                    targetMember.voice.channelId === channel.id
                ) {
                    await targetMember.voice.disconnect();
                }
                await sendBlogLog(
                    interaction.guild,
                    'CẤM',
                    `${interaction.user} cấm ${targetMember}`
                );
                return interaction.reply({
                    content: `🚫 Đã cấm thành viên **${targetMember.displayName}** khỏi phòng.`,
                    ephemeral: true
                });
            }

            if (interaction.customId === 'modal_kick') {
                if (
                    targetMember.voice &&
                    targetMember.voice.channelId === channel.id
                ) {
                    await targetMember.voice.disconnect();
                    await sendBlogLog(
                        interaction.guild,
                        'ĐUỔI',
                        `${interaction.user} đá ${targetMember} ra khỏi phòng`
                    );
                    return interaction.reply({
                        content: `🩴 Đã mời thành viên **${targetMember.displayName}** rời khỏi phòng.`,
                        ephemeral: true
                    });
                }
                return interaction.reply({
                    content: '❌ Thành viên này hiện không có trong phòng của bạn.',
                    ephemeral: true
                });
            }
        }

        if (interaction.customId === 'modal_transfer') {
            const uidStr = interaction.fields
                .getTextInputValue('input_uid')
                .trim();
            const uid = parseInt(uidStr);

            if (isNaN(uid)) {
                return interaction.reply({
                    content: '❌ ID Discord không hợp lệ.',
                    ephemeral: true
                });
            }

            const targetMember = await interaction.guild.members
                .fetch(uid)
                .catch(() => null);

            if (
                !targetMember ||
                targetMember.voice.channelId !== channel.id
            ) {
                return interaction.reply({
                    content: '❌ Người nhận quyền phải đang có mặt trực tiếp trong phòng thoại với bạn.',
                    ephemeral: true
                });
            }

            await saveRoom(
                interaction.guild.id,
                channel.id,
                targetMember.id,
                channel.parentId || 0
            );
            await ensureRoomManagementPermissions(channel, targetMember.id);
            await sendBlogLog(
                interaction.guild,
                'CHUYỂN CHỦ',
                `Phòng ${channel} chuyển quyền cho ${targetMember}`
            );

            const newEmbed = new EmbedBuilder()
                .setTitle('🛡️ TRUNG TÂM QUẢN LÝ PHÒNG THOẠI')
                .setDescription(
                    `👑 **Chủ phòng:** ${targetMember}\n\n` +
                    `📜 **NỘI QUY & GIAO LƯU VĂN MINH:**\n` +
                    `• Trò chuyện văn minh, lịch sự và tôn trọng lẫn nhau.\n` +
                    `• Tuyệt đối không có hành vi xúc phạm, đả kích hay dùng từ ngữ kém văn hóa.\n` +
                    `• Cùng nhau xây dựng không gian giao lưu vui vẻ, lành mạnh và tràn ngập những giá trị tích cực! ✨`
                )
                .setColor(0x1E90FF)
                .setThumbnail(targetMember.user.displayAvatarURL())
                .setFooter({ text: 'Hệ thống quản lý phòng thoại tự động' })
                .setTimestamp();

            try {
                await interaction.message.edit({
                    embeds: [newEmbed],
                    components: getControlRows(true)
                });
            } catch (e) {}

            return interaction.reply({
                content: `👑 Đã chuyển quyền chủ phòng thành công cho **${targetMember.displayName}**!`,
                ephemeral: true
            });
        }
    }
});

// ============================================================
// LOGIN
// ============================================================

client.login(TOKEN);
