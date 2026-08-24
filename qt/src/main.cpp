#include <QApplication>
#include <QQmlApplicationEngine>
#include <QQmlContext>
#include <QQuickWindow>
#include <QIcon>
#include <QQuickStyle>
#include <QDir>
#include <QDebug>
#include <QtWebEngineQuick/qtwebenginequickglobal.h>

#include "core/AppConfig.hpp"
#include "core/DatabaseManager.hpp"
#include "core/I18n.hpp"
#include "core/SystemTrayManager.hpp"
#include "core/SoundEffectManager.hpp"
#include "controllers/AppController.hpp"
#include "models/CharacterListModel.hpp"
#include "models/ChatMessageModel.hpp"
#include "models/PresetListModel.hpp"
#include "models/LorebookListModel.hpp"

int main(int argc, char *argv[]) {
    QtWebEngineQuick::initialize();
    QApplication app(argc, argv);
    app.setOrganizationName(QStringLiteral("RisuAI"));
    app.setOrganizationDomain(QStringLiteral("risuai.xyz"));
    app.setApplicationName(QStringLiteral("RisuAI"));
    app.setApplicationVersion(QStringLiteral("2026.8"));

    QQuickStyle::setStyle(QStringLiteral("Basic"));

    // Initialize Database & Storage
    if (!Risu::DatabaseManager::instance().initDatabase()) {
        qCritical() << "Could not initialize database. Exiting.";
        return 1;
    }

    QQmlApplicationEngine engine;
    engine.addImportPath(QStringLiteral("qrc:/"));
    engine.addImportPath(QStringLiteral("qrc:/qml"));

    // Register C++ Types to QML
    qmlRegisterUncreatableType<Risu::ChatMessageModel>("Risu", 1, 0, "ChatMessageModel", QStringLiteral("Cannot instantiate"));
    qmlRegisterUncreatableType<Risu::CharacterListModel>("Risu", 1, 0, "CharacterListModel", QStringLiteral("Cannot instantiate"));
    qmlRegisterUncreatableType<Risu::PresetListModel>("Risu", 1, 0, "PresetListModel", QStringLiteral("Cannot instantiate"));
    qmlRegisterUncreatableType<Risu::LorebookListModel>("Risu", 1, 0, "LorebookListModel", QStringLiteral("Cannot instantiate"));
    qmlRegisterUncreatableType<Risu::GroupListModel>("Risu", 1, 0, "GroupListModel", QStringLiteral("Cannot instantiate"));

    qmlRegisterSingletonType(QUrl(QStringLiteral("qrc:/qml/theme/Theme.qml")), "Theme", 1, 0, "Theme");

    Risu::AppController appController;
    engine.rootContext()->setContextProperty(QStringLiteral("appCtrl"), &appController);
    engine.rootContext()->setContextProperty(QStringLiteral("chatCtrl"), appController.chat());
    engine.rootContext()->setContextProperty(QStringLiteral("charCtrl"), appController.character());
    engine.rootContext()->setContextProperty(QStringLiteral("presetCtrl"), appController.preset());
    engine.rootContext()->setContextProperty(QStringLiteral("loreCtrl"), appController.lorebook());
    engine.rootContext()->setContextProperty(QStringLiteral("personaCtrl"), appController.persona());
    engine.rootContext()->setContextProperty(QStringLiteral("ttsCtrl"), appController.tts());
    engine.rootContext()->setContextProperty(QStringLiteral("imageGenCtrl"), appController.imageGen());
    engine.rootContext()->setContextProperty(QStringLiteral("groupCtrl"), appController.group());
    engine.rootContext()->setContextProperty(QStringLiteral("apiServerCtrl"), appController.apiServer());
    engine.rootContext()->setContextProperty(QStringLiteral("i18n"), &Risu::I18n::instance());
    engine.rootContext()->setContextProperty(QStringLiteral("appConfig"), appController.config());
    engine.rootContext()->setContextProperty(QStringLiteral("sfx"), &Risu::SoundEffectManager::instance());

    // Check CLI argument or auto-detect backup file
    QStringList args = app.arguments();
    for (int i = 1; i < args.size(); ++i) {
        QString arg = args[i];
        if (QFile::exists(arg) && (arg.endsWith(QStringLiteral(".bin"), Qt::CaseInsensitive) || 
                                   arg.endsWith(QStringLiteral(".risubackup"), Qt::CaseInsensitive) || 
                                   arg.endsWith(QStringLiteral(".json"), Qt::CaseInsensitive))) {
            qInfo() << "Importing backup specified from CLI:" << arg;
            appController.restoreData(arg);
            break;
        }
    }

    const QUrl url(QStringLiteral("qrc:/qml/Main.qml"));
    QObject::connect(
        &engine,
        &QQmlApplicationEngine::objectCreated,
        &app,
        [url](QObject *obj, const QUrl &objUrl) {
            if (!obj && url == objUrl) {
                QCoreApplication::exit(-1);
            } else if (obj && url == objUrl) {
                Risu::SystemTrayManager::instance().init(qobject_cast<QWindow*>(obj));
            }
        },
        Qt::QueuedConnection
    );

    engine.load(url);

    return app.exec();
}
